import prisma from '../config/prisma';
import { deleteCachePattern } from '../config/redis';
import { convertAmountsToCurrency } from './exchangeRate.service';
import { storeExpenseEmbedding } from './rag.service';

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
  const createdExpenses = await Promise.all(
    parsedExpenses.map(async (expense) => {
      const created = await prisma.expense.create({
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
      });

      storeExpenseEmbedding(created).catch((err) => {
        console.error('Failed to store embedding:', err);
      });

      return created;
    })
  );

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

