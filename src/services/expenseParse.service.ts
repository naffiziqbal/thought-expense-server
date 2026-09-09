import prisma from '../config/prisma';
import { deleteCachePattern } from '../config/redis';
import { convertAmountsToCurrency } from './exchangeRate.service';
import { storeExpenseEmbedding } from './rag.service';
import { logger } from '../config/logger';

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
          date: new Date(expense.date),
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

  const convertedExpenses = await convertAmountsToCurrency(createdExpenses, userCurrency || 'USD');
  const needsReview = createdExpenses
    .filter((e) => e.confidence < parseFloat(process.env.CLASSIFICATION_CONFIDENCE_THRESHOLD || '0.7'))
    .map((e) => e.id);

  return {
    expenses: convertedExpenses,
    needsReview,
  };
};

