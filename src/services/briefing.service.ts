/**
 * Weekly Financial Briefing — the retention loop.
 * Generated on a schedule (see workers/briefing.worker.ts), stored as an
 * Insight of type 'briefing', and delivered by email via Resend.
 */

import prisma from '../config/prisma';
import { convertAmountsToCurrency } from './exchangeRate.service';
import { buildAdvisorContext } from './financialContext.service';
import { generateBriefingContent, BriefingContent } from './advisor.service';
import { sendWeeklyBriefingEmail } from './email.service';
import { deleteCachePattern } from '../config/redis';

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function weekTotals(
  userId: string,
  currency: string,
  start: Date,
  end: Date
): Promise<{ total: number; byCategory: Record<string, number>; count: number }> {
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
  return { total: round2(total), byCategory, count: rows.length };
}

export interface BriefingResult {
  generated: boolean;
  reason?: string;
  briefing?: BriefingContent;
  insightId?: string;
  emailed?: boolean;
}

export async function generateWeeklyBriefingForUser(
  userId: string,
  options: { sendEmail?: boolean } = {}
): Promise<BriefingResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, currency: true, isPremium: true },
  });
  if (!user) return { generated: false, reason: 'User not found' };

  const currency = user.currency || 'USD';
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [thisWeek, lastWeek] = await Promise.all([
    weekTotals(userId, currency, weekAgo, now),
    weekTotals(userId, currency, twoWeeksAgo, weekAgo),
  ]);

  if (thisWeek.count === 0 && lastWeek.count === 0) {
    return { generated: false, reason: 'No activity in the last two weeks' };
  }

  const ctx = await buildAdvisorContext(userId, currency, user.isPremium);
  const briefing = await generateBriefingContent(ctx, thisWeek.total, lastWeek.total, thisWeek.byCategory);

  const insight = await prisma.insight.create({
    data: {
      userId,
      type: 'briefing',
      content: briefing.summary,
      metadata: {
        briefing: briefing as any,
        weekTotal: thisWeek.total,
        previousWeekTotal: lastWeek.total,
        byCategory: thisWeek.byCategory,
        currency,
        period: { start: weekAgo.toISOString(), end: now.toISOString() },
      },
      period: now,
    },
  });

  await deleteCachePattern(`insights:${userId}:*`);

  let emailed = false;
  if (options.sendEmail !== false) {
    const result = await sendWeeklyBriefingEmail(user.email, {
      name: user.name,
      briefing,
      weekTotal: thisWeek.total,
      previousWeekTotal: lastWeek.total,
      currency,
      isPremium: user.isPremium,
    });
    emailed = result.success;
  }

  return { generated: true, briefing, insightId: insight.id, emailed };
}

/**
 * Users who logged at least one expense in the last 30 days get a briefing.
 */
export async function listBriefingRecipients(): Promise<string[]> {
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  const rows = await prisma.expense.findMany({
    where: { date: { gte: monthAgo } },
    distinct: ['userId'],
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}
