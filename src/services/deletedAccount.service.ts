import prisma from '../config/prisma';
import { logger } from '../config/logger';
import { getUserAiLifetime } from './aiMetrics.service';

/**
 * Keep an anonymous record of an account before it is deleted, so churn and
 * retention metrics still count users who left. Stores no email, name or expenses.
 * Never throws: a failure here must not block the user's deletion request.
 */
export async function archiveDeletedAccount(userId: string, reason = 'self_delete'): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        createdAt: true,
        currency: true,
        isPremium: true,
        subscriptionStatus: true,
        subscriptionProductId: true,
        subscriptionStore: true,
        premiumSince: true,
        lastActiveAt: true,
        _count: { select: { expenses: true } },
      },
    });
    if (!user) return;

    const [lastExpense, ai] = await Promise.all([
      prisma.expense.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      getUserAiLifetime(userId),
    ]);

    await prisma.deletedAccount.create({
      data: {
        userId,
        signupAt: user.createdAt,
        reason,
        currency: user.currency,
        wasPremium: user.isPremium,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionProductId: user.subscriptionProductId,
        subscriptionStore: user.subscriptionStore,
        premiumSince: user.premiumSince,
        lastActiveAt: user.lastActiveAt,
        lastExpenseAt: lastExpense?.createdAt ?? null,
        expenseCount: user._count.expenses,
        aiCalls: ai.calls,
        aiCostUsd: ai.costUsd,
      },
    });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to archive deleted account');
  }
}
