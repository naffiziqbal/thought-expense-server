/**
 * Budget threshold pushes. Fired after expenses are written, deduped in Redis
 * so a user gets each threshold at most once per calendar month.
 */

import prisma from '../config/prisma';
import { logger } from '../config/logger';
import { setCacheNx } from '../config/redis';
import { convertAmountsToCurrency } from './exchangeRate.service';
import { sendPushToUser } from './push.service';

const THRESHOLDS = [100, 80] as const;
const DEDUPE_TTL_SEC = 60 * 60 * 24 * 40;

async function monthlyLimit(userId: string, month: number, year: number): Promise<number | null> {
  const budget = await prisma.budget.findUnique({
    where: { userId_month_year: { userId, month, year } },
    select: { totalLimit: true },
  });
  if (budget) return budget.totalLimit;

  const categoryBudgets = await prisma.categoryBudget.findMany({
    where: { userId, month, year },
    select: { limit: true },
  });
  if (categoryBudgets.length === 0) return null;
  return categoryBudgets.reduce((sum, cb) => sum + cb.limit, 0);
}

/**
 * Check the current month against the user's budget and push once when a
 * threshold is first crossed. Safe to call fire-and-forget.
 */
export async function checkBudgetAndNotify(userId: string): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true, pushEnabled: true, budgetAlertsEnabled: true },
    });
    if (!user || !user.pushEnabled || !user.budgetAlertsEnabled) return;

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const limit = await monthlyLimit(userId, month, year);
    if (!limit || limit <= 0) return;

    const rows = await prisma.expense.findMany({
      where: {
        userId,
        date: {
          gte: new Date(year, month - 1, 1),
          lte: new Date(year, month, 0, 23, 59, 59, 999),
        },
      },
      select: { amount: true, currency: true },
    });
    if (rows.length === 0) return;

    const currency = user.currency || 'USD';
    const converted = await convertAmountsToCurrency(rows, currency);
    const spent = converted.reduce((sum, e) => sum + e.amount, 0);
    const percentage = Math.round((spent / limit) * 100);

    const crossed = THRESHOLDS.find((t) => percentage >= t);
    if (!crossed) return;

    const lock = await setCacheNx(
      `budget-alert:${userId}:${year}-${month}:${crossed}`,
      { percentage },
      DEDUPE_TTL_SEC
    );
    if (lock !== 'ok') return;

    const remaining = Math.max(0, limit - spent);
    await sendPushToUser(userId, {
      title: crossed === 100 ? 'Monthly budget reached' : 'You are at 80% of your budget',
      body:
        crossed === 100
          ? `You've spent ${percentage}% of this month's budget.`
          : `${remaining.toFixed(0)} ${currency} left for the rest of the month.`,
      data: { screen: 'budget' },
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Budget alert check failed');
  }
}
