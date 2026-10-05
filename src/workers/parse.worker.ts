import { Job, Worker } from 'bullmq';
import prisma from '../config/prisma';
import {
  categoryBudgetParseQueue,
  CategoryBudgetParseJobData,
  CategoryBudgetParseJobResult,
  CATEGORY_BUDGET_PARSE_QUEUE,
} from '../queues/categoryBudgetParse.queue';
import {
  expenseParseQueue,
  ExpenseParseJobData,
  ExpenseParseJobResult,
  EXPENSE_PARSE_QUEUE,
  LocalPreviewExpense,
} from '../queues/expenseParse.queue';
import { queueConnection } from '../queues/queue.connection';
import {
  extractImportDocumentText,
  parseCategoryBudgets,
  parseExpenses,
} from '../services/gemini.service';
import {
  persistParsedExpenses,
  applySelectedExpenseDate,
  resolveSelectedExpenseDate,
} from '../services/expenseParse.service';
import { getUserContext, updateCategoryMapping } from '../services/rag.service';
import { withIdempotency } from '../services/idempotency.service';
import { logger } from '../config/logger';
import { notifyDocumentImportComplete } from '../services/importPush.service';
import * as Sentry from '@sentry/node';

let expenseWorker: Worker<ExpenseParseJobData, ExpenseParseJobResult> | null = null;
let categoryBudgetWorker: Worker<CategoryBudgetParseJobData, CategoryBudgetParseJobResult> | null =
  null;

function previewToParsed(preview: LocalPreviewExpense[], userCurrency: string, rawInput: string) {
  return preview
    .filter((p) => p.description && Number(p.amount) > 0)
    .map((p) => ({
      description: p.description,
      amount: Number(p.amount),
      currency: (p.currency || userCurrency).toUpperCase(),
      category: p.category || 'Other',
      confidence: 0.6,
      date: p.date || new Date().toISOString().split('T')[0],
      rawInput: p.rawInput || rawInput,
    }));
}

function isLastAttempt(job: Job): boolean {
  const max = job.opts.attempts ?? 1;
  return job.attemptsMade + 1 >= max;
}

const IMPORT_CANCELLED = 'Import cancelled by user';

async function throwIfImportCancelled(job: Job<ExpenseParseJobData>): Promise<void> {
  if (!job.data.importFileName) return;
  const fresh = await expenseParseQueue.getJob(job.id!);
  if (fresh?.data.cancelled) {
    throw new Error(IMPORT_CANCELLED);
  }
}

async function persistCreated(
  userId: string,
  parsedExpenses: Array<{
    description: string;
    amount: number;
    currency: string;
    category: string;
    confidence: number;
    date: string;
    rawInput?: string;
  }>,
  rawInput: string,
  userCurrency: string,
  jobKey: string
): Promise<ExpenseParseJobResult> {
  return withIdempotency('expense-parse-job', userId, jobKey, async () => {
    await Promise.all(
      parsedExpenses.map((expense) =>
        updateCategoryMapping(userId, expense.description, expense.category).catch((err) => {
          logger.error({ err }, 'Failed to update category mapping from parsed item');
        })
      )
    );
    const persisted = await persistParsedExpenses(userId, parsedExpenses, rawInput, userCurrency);
    return {
      expenses: persisted.expenses,
      needsReview: persisted.needsReview,
      created: true,
    };
  });
}

async function finishDocumentImport(
  job: Job<ExpenseParseJobData>,
  userId: string,
  result: ExpenseParseJobResult
): Promise<ExpenseParseJobResult> {
  if (job.data.importFileName) {
    await job.updateProgress(100).catch(() => undefined);
    notifyDocumentImportComplete(userId, {
      fileName: job.data.importFileName,
      importedCount: result.expenses?.length ?? 0,
    });
  }
  return result;
}

export const startParseWorkers = () => {
  if (!expenseWorker) {
    expenseWorker = new Worker<ExpenseParseJobData, ExpenseParseJobResult>(
      EXPENSE_PARSE_QUEUE,
      async (job: Job<ExpenseParseJobData>) => {
        const { userId, create, userCurrency, localPreview, date, documentBase64, documentMime } =
          job.data;
        let rawInput = job.data.rawInput;
        const isDocumentImport = !!(documentBase64 && documentMime);
        const jobKey = String(job.id);
        const selectedDate = date || resolveSelectedExpenseDate({ date, localPreview });

        if (isDocumentImport) {
          await job.updateProgress(5).catch(() => undefined);
        }

        await throwIfImportCancelled(job);

        if (isDocumentImport) {
          await job.updateProgress(8);
          const extracted = await extractImportDocumentText(documentBase64, documentMime, userId);
          await throwIfImportCancelled(job);
          await job.updateProgress(38);
          if (!extracted.trim()) {
            throw new Error('Could not read any expenses from this document');
          }
          rawInput = extracted;
          await job.updateData({
            ...job.data,
            rawInput: extracted,
            documentBase64: undefined,
          });
        }

        const fallback = applySelectedExpenseDate(
          previewToParsed(localPreview || [], userCurrency, rawInput),
          selectedDate
        );

        let parsedExpenses;
        try {
          await throwIfImportCancelled(job);
          await job.updateProgress(isDocumentImport ? 48 : 20);
          const userContext = await getUserContext(userId);
          parsedExpenses = applySelectedExpenseDate(
            await parseExpenses(
              rawInput,
              userCurrency,
              userContext,
              selectedDate,
              'parse_async',
              userId
            ),
            selectedDate
          );
          await job.updateProgress(72);
          await throwIfImportCancelled(job);
        } catch (err) {
          if (err instanceof Error && err.message === IMPORT_CANCELLED) {
            throw err;
          }
          if (isLastAttempt(job) && create && fallback.length > 0) {
            logger.warn(
              { jobId: job.id, err },
              'Parse exhausted retries; persisting local preview'
            );
            const fallbackResult = await persistCreated(
              userId,
              fallback,
              rawInput,
              userCurrency,
              jobKey
            );
            return finishDocumentImport(job, userId, fallbackResult);
          }
          throw err;
        }

        if (!parsedExpenses || parsedExpenses.length === 0) {
          if (create && fallback.length > 0) {
            const fallbackResult = await persistCreated(
              userId,
              fallback,
              rawInput,
              userCurrency,
              jobKey
            );
            return finishDocumentImport(job, userId, fallbackResult);
          }
          throw new Error('Could not parse any expenses from input');
        }

        if (!create) {
          return {
            expenses: parsedExpenses,
            created: false,
            needsReview: [],
          };
        }

        await throwIfImportCancelled(job);
        await job.updateProgress(88);
        const result = await persistCreated(userId, parsedExpenses, rawInput, userCurrency, jobKey);
        return finishDocumentImport(job, userId, result);
      },
      {
        connection: queueConnection,
        // OCR + parse can run several minutes; default 30s lock causes false "stalled" → back to waiting (looks stuck on Queued).
        lockDuration: 10 * 60 * 1000,
        stalledInterval: 60 * 1000,
        maxStalledCount: 2,
      }
    );
  }

  if (!categoryBudgetWorker) {
    categoryBudgetWorker = new Worker<CategoryBudgetParseJobData, CategoryBudgetParseJobResult>(
      CATEGORY_BUDGET_PARSE_QUEUE,
      async (job: Job<CategoryBudgetParseJobData>) => {
        const { userId, text } = job.data;
        const rows = await prisma.expense.findMany({
          where: { userId },
          distinct: ['category'],
          select: { category: true },
          take: 50,
        });
        const known = rows.map((r) => r.category);
        const items = await parseCategoryBudgets(text, known, userId);
        if (!items || items.length === 0) {
          throw new Error('Could not parse any category budgets from input');
        }
        return { items };
      },
      { connection: queueConnection }
    );
  }

  expenseWorker.on('failed', (job, error) => {
    const max = job?.opts.attempts ?? 1;
    const final = (job?.attemptsMade ?? 0) >= max;
    if (!final) {
      logger.warn(
        { err: error, jobId: job?.id, attempt: job?.attemptsMade },
        'Expense parse job retrying'
      );
      return;
    }
    logger.error({ err: error, jobId: job?.id }, 'Expense parse job failed');
    Sentry.captureException(error);
  });

  categoryBudgetWorker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id }, 'Category budget parse job failed');
    Sentry.captureException(error);
  });
};

export const stopParseWorkers = async () => {
  await Promise.all([
    expenseWorker?.close(),
    categoryBudgetWorker?.close(),
    expenseParseQueue.close(),
    categoryBudgetParseQueue.close(),
    queueConnection.quit(),
  ]);
};
