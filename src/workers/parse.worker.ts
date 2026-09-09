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
} from '../queues/expenseParse.queue';
import { queueConnection } from '../queues/queue.connection';
import { parseCategoryBudgets, parseExpenses } from '../services/gemini.service';
import { persistParsedExpenses } from '../services/expenseParse.service';
import { getUserContext, updateCategoryMapping } from '../services/rag.service';
import { logger } from '../config/logger';
import * as Sentry from '@sentry/node';

let expenseWorker: Worker<ExpenseParseJobData, ExpenseParseJobResult> | null = null;
let categoryBudgetWorker: Worker<CategoryBudgetParseJobData, CategoryBudgetParseJobResult> | null = null;

export const startParseWorkers = () => {
  if (!expenseWorker) {
    expenseWorker = new Worker<ExpenseParseJobData, ExpenseParseJobResult>(
      EXPENSE_PARSE_QUEUE,
      async (job: Job<ExpenseParseJobData>) => {
        const { userId, rawInput, create, userCurrency } = job.data;
        const userContext = await getUserContext(userId);
        const parsedExpenses = await parseExpenses(rawInput, userCurrency, userContext);

        if (!parsedExpenses || parsedExpenses.length === 0) {
          throw new Error('Could not parse any expenses from input');
        }

        if (!create) {
          return {
            expenses: parsedExpenses,
            created: false,
            needsReview: [],
          };
        }

        // Learn from newly parsed items for future fast categorization consistency.
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
      },
      { connection: queueConnection }
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
        const items = await parseCategoryBudgets(text, known);
        if (!items || items.length === 0) {
          throw new Error('Could not parse any category budgets from input');
        }
        return { items };
      },
      { connection: queueConnection }
    );
  }

  expenseWorker.on('failed', (job, error) => {
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

