/**
 * Plain text search over expense history (no AI / vectors).
 */

import prisma from '../config/prisma';
import type { Prisma } from '@prisma/client';

export interface ParsedSearchQuery {
  semanticQuery: string;
}

export interface SearchResultExpense {
  id: string;
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: Date;
  matchType: 'keyword';
}

export interface SearchResult {
  query: string;
  parsed: ParsedSearchQuery;
  expenses: SearchResultExpense[];
  total: number;
  totalAmount: number;
  currency: string;
}

function freeTierDateFloor(isPremium: boolean): Date | undefined {
  if (isPremium) return undefined;
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  threeMonthsAgo.setHours(0, 0, 0, 0);
  return threeMonthsAgo;
}

function textMatchWhere(term: string): Prisma.ExpenseWhereInput {
  return {
    OR: [
      { description: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { rawInput: { contains: term, mode: 'insensitive' } },
    ],
  };
}

export async function searchExpenses(
  userId: string,
  query: string,
  userCurrency: string,
  isPremium: boolean,
  limit: number = 50
): Promise<SearchResult> {
  const rawQuery = query.trim();
  if (!rawQuery) {
    return {
      query: rawQuery,
      parsed: { semanticQuery: rawQuery },
      expenses: [],
      total: 0,
      totalAmount: 0,
      currency: userCurrency,
    };
  }

  const where: Prisma.ExpenseWhereInput = {
    userId,
    ...textMatchWhere(rawQuery),
  };

  const floor = freeTierDateFloor(isPremium);
  if (floor) {
    where.date = { gte: floor };
  }

  const rows = await prisma.expense.findMany({
    where,
    orderBy: { date: 'desc' },
    take: limit,
  });

  const totalAmount = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;

  return {
    query: rawQuery,
    parsed: { semanticQuery: rawQuery },
    expenses: rows.map((e) => ({
      id: e.id,
      description: e.description,
      amount: e.amount,
      currency: e.currency,
      category: e.category,
      date: e.date,
      matchType: 'keyword' as const,
    })),
    total: rows.length,
    totalAmount,
    currency: userCurrency,
  };
}
