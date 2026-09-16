/**
 * Builds the AdvisorContext the AI advisor reasons over: current + previous
 * month summaries, budget, goals, and detected intelligence — everything
 * currency-normalized.
 */

import prisma from '../config/prisma';
import { convertAmountsToCurrency, convertLimitsToCurrency } from './exchangeRate.service';
import { getSpendingIntelligence } from './analytics.service';
import { AdvisorContext } from './advisor.service';

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function monthSummary(
  userId: string,
  currency: string,
  year: number,
  month: number // 0-based
): Promise<{ month: string; total: number; byCategory: Record<string, number>; transactionCount: number }> {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  const rows = await prisma.expense.findMany({
    where: { userId, date: { gte: start, lt: end } },
    select: { amount: true, currency: true, category: true },
  });
  const converted = await convertAmountsToCurrency(rows, currency);
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const e of converted) {
    total += e.amount;
    byCategory[e.category] = round2((byCategory[e.category] || 0) + e.amount);
  }
  return {
    month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
    total: round2(total),
    byCategory,
    transactionCount: rows.length,
  };
}

export async function buildAdvisorContext(
  userId: string,
  currency: string,
  isPremium: boolean
): Promise<AdvisorContext> {
  const now = new Date();

  const [current, previous, intelligence, goals, budget, topRows] = await Promise.all([
    monthSummary(userId, currency, now.getFullYear(), now.getMonth()),
    monthSummary(userId, currency, now.getFullYear(), now.getMonth() - 1),
    getSpendingIntelligence(userId, currency, isPremium),
    prisma.goal.findMany({
      where: { userId, status: 'active' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.budget.findFirst({
      where: { userId, month: now.getMonth() + 1, year: now.getFullYear() },
    }),
    prisma.expense.findMany({
      where: { userId, date: { gte: new Date(now.getFullYear(), now.getMonth() - 1, 1) } },
      orderBy: { amount: 'desc' },
      take: 8,
      select: { description: true, category: true, amount: true, currency: true, date: true },
    }),
  ]);

  const topConverted = await convertAmountsToCurrency(topRows, currency);

  // The advisor quotes these numbers verbatim, so the limit has to be in the
  // same currency as the spend it is compared against.
  const [budgetLimit] = budget
    ? await convertLimitsToCurrency([{ limit: budget.totalLimit, currency: budget.currency }], currency)
    : [0];

  return {
    currency,
    currentMonth: current,
    previousMonth: previous.transactionCount > 0 ? previous : undefined,
    budget: budget
      ? {
          totalLimit: budgetLimit,
          totalSpent: current.total,
          remaining: round2(budgetLimit - current.total),
        }
      : null,
    goals: goals.map((g) => ({
      name: g.name,
      targetAmount: g.targetAmount,
      savedAmount: g.savedAmount,
      deadline: g.deadline ? g.deadline.toISOString() : null,
    })),
    intelligence: {
      anomalies: intelligence.anomalies,
      trends: intelligence.trends,
      waste: intelligence.waste,
      recurring: intelligence.recurring,
    },
    topExpenses: topConverted.map((e) => ({
      description: e.description,
      category: e.category,
      amount: e.amount,
      date: new Date(e.date).toISOString(),
    })),
  };
}
