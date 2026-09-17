import prisma from '../config/prisma';
import { deleteCachePattern } from '../config/redis';
import { convertAmountsToCurrency } from './exchangeRate.service';
import { storeExpenseEmbedding } from './rag.service';
import { checkBudgetAndNotify } from './budgetAlert.service';
import { logger } from '../config/logger';

/** Calendar day (YYYY-MM-DD) from a picker value or ISO datetime. */
export function normalizeExpenseYmd(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ymd = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : undefined;
}

/** Prefer the explicit picker date, then the first local-preview row. */
export function resolveSelectedExpenseDate(input: {
  date?: unknown;
  localPreview?: Array<{ date?: unknown }> | unknown;
}): string | undefined {
  const fromBody = normalizeExpenseYmd(input.date);
  if (fromBody) return fromBody;
  if (!Array.isArray(input.localPreview)) return undefined;
  for (const item of input.localPreview) {
    const ymd = normalizeExpenseYmd((item as { date?: unknown } | null)?.date);
    if (ymd) return ymd;
  }
  return undefined;
}

export function applySelectedExpenseDate<T extends { date: string }>(
  expenses: T[],
  selectedDate?: string
): T[] {
  if (!selectedDate) return expenses;
  return expenses.map((expense) => ({ ...expense, date: selectedDate }));
}

/** Noon UTC so the calendar day does not slip when Prisma stores a DateTime. */
export function expenseDateFromYmd(value: string): Date {
  const ymd = normalizeExpenseYmd(value);
  if (ymd) return new Date(`${ymd}T12:00:00.000Z`);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

interface ParsedExpenseInput {
  description: string;
  amount: number;
  currency: string;
  category: string;
  confidence: number;
  date: string;
  rawInput?: string;
}

export const persistParsedExpenses = async (
  userId: string,
  parsedExpenses: ParsedExpenseInput[],
  rawInput: string,
  userCurrency: string
) => {
  const createdExpenses = await prisma.$transaction(
    parsedExpenses.map((expense) =>
      prisma.expense.create({
        data: {
          userId,
          description: expense.description,
          amount: expense.amount,
          currency: expense.currency,
          category: expense.category,
          confidence: expense.confidence,
          rawInput: expense.rawInput || rawInput,
          date: expenseDateFromYmd(expense.date),
        },
      })
    )
  );

  for (const created of createdExpenses) {
    storeExpenseEmbedding(created).catch((err) => {
      logger.error({ err, expenseId: created.id }, 'Failed to store embedding');
    });
  }

  await deleteCachePattern(`expenses:${userId}:*`);
  await deleteCachePattern(`summary:${userId}:*`);

  void checkBudgetAndNotify(userId);

  const convertedExpenses = await convertAmountsToCurrency(createdExpenses, userCurrency || 'USD');
  const needsReview = createdExpenses
    .filter((e) => e.confidence < parseFloat(process.env.CLASSIFICATION_CONFIDENCE_THRESHOLD || '0.7'))
    .map((e) => e.id);

  return {
    expenses: convertedExpenses,
    needsReview,
  };
};

