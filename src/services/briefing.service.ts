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

/** Monday 00:00 UTC of the ISO week containing `d`. */
function startOfUtcIsoWeek(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date;
}

export function utcIsoWeekKey(d: Date = new Date()): string {
  return startOfUtcIsoWeek(d).toISOString().slice(0, 10);
}

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

  const weekStart = startOfUtcIsoWeek(now);
  const existing = await prisma.insight.findFirst({
    where: { userId, type: 'briefing', createdAt: { gte: weekStart } },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    const meta = (existing.metadata || {}) as Record<string, unknown>;
    let emailed = Boolean(meta.emailed);
    if (options.sendEmail !== false && !emailed) {
      const stored = meta.briefing as BriefingContent | undefined;
      if (stored) {
        const result = await sendWeeklyBriefingEmail(user.email, {
          name: user.name,
          briefing: stored,
          weekTotal: thisWeek.total,
          previousWeekTotal: lastWeek.total,
          currency,
          isPremium: user.isPremium,
        });
        emailed = result.success;
        if (emailed) {
          await prisma.insight.update({
            where: { id: existing.id },
            data: { metadata: { ...meta, emailed: true } },
          });
        }
      }
    }
    return {
      generated: true,
      briefing: (meta.briefing as BriefingContent) || undefined,
      insightId: existing.id,
      emailed,
      reason: 'already generated this week',
    };
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
        emailed: false,
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
    if (emailed) {
      await prisma.insight.update({
        where: { id: insight.id },
        data: {
          metadata: {
            briefing: briefing as any,
            weekTotal: thisWeek.total,
            previousWeekTotal: lastWeek.total,
            byCategory: thisWeek.byCategory,
            currency,
            period: { start: weekAgo.toISOString(), end: now.toISOString() },
            emailed: true,
          },
        },
      });
    }
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
