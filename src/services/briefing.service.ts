/**
 * Weekly Financial Briefing — the retention loop.
 * Generated on a schedule (see workers/briefing.worker.ts), stored as an
 * Insight of type 'briefing'. Email delivery (Resend) is Premium only.
 */

import prisma from '../config/prisma';
import { convertAmountsToCurrency } from './exchangeRate.service';
import { buildAdvisorContext } from './financialContext.service';
import { generateBriefingContent, BriefingContent } from './advisor.service';
import { sendWeeklyBriefingEmail } from './email.service';
import { sendPushToUser } from './push.service';
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
  options: {
    sendEmail?: boolean;
    includeBackupKey?: boolean;
    /** On-demand: rewrite this week's briefing when the numbers behind it have changed. */
    refresh?: boolean;
    /** Push "briefing ready" — pointless when the user asked for it and is looking at it. */
    notify?: boolean;
  } = {}
): Promise<BriefingResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, currency: true, isPremium: true },
  });
  if (!user) return { generated: false, reason: 'User not found' };

  const shouldSendEmail = options.sendEmail !== false && user.isPremium;

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

  const meta = (existing?.metadata || {}) as Record<string, unknown>;
  const unchanged =
    meta.weekTotal === thisWeek.total &&
    meta.previousWeekTotal === lastWeek.total &&
    meta.expenseCount === thisWeek.count &&
    meta.currency === currency;

  if (existing && (!options.refresh || unchanged)) {
    let emailed = Boolean(meta.emailed);
    if (shouldSendEmail && !emailed) {
      const stored = meta.briefing as BriefingContent | undefined;
      if (stored) {
        const result = await sendWeeklyBriefingEmail(user.email, {
          name: user.name,
          briefing: stored,
          weekTotal: thisWeek.total,
          previousWeekTotal: lastWeek.total,
          currency,
          isPremium: true,
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
  const briefing = await generateBriefingContent(
    ctx,
    thisWeek.total,
    lastWeek.total,
    thisWeek.byCategory,
    { includeBackupKey: options.includeBackupKey }
  );

  const metadata = {
    briefing: briefing as any,
    weekTotal: thisWeek.total,
    previousWeekTotal: lastWeek.total,
    expenseCount: thisWeek.count,
    byCategory: thisWeek.byCategory,
    currency,
    period: { start: weekAgo.toISOString(), end: now.toISOString() },
    emailed: false,
  };

  if (existing) {
    // Refreshed mid-week: one briefing per week, so update it in place. Keep the email
    // flag — the weekly email already went out with the earlier numbers.
    await prisma.insight.update({
      where: { id: existing.id },
      data: {
        content: briefing.summary,
        metadata: { ...metadata, emailed: Boolean(meta.emailed) },
        period: now,
      },
    });
    await deleteCachePattern(`insights:${userId}:*`);
    return { generated: true, briefing, insightId: existing.id, emailed: Boolean(meta.emailed) };
  }

  const insight = await prisma.insight.create({
    data: { userId, type: 'briefing', content: briefing.summary, metadata, period: now },
  });

  await deleteCachePattern(`insights:${userId}:*`);

  let emailed = false;
  if (shouldSendEmail) {
    const result = await sendWeeklyBriefingEmail(user.email, {
      name: user.name,
      briefing,
      weekTotal: thisWeek.total,
      previousWeekTotal: lastWeek.total,
      currency,
      isPremium: true,
    });
    emailed = result.success;
    if (emailed) {
      await prisma.insight.update({
        where: { id: insight.id },
        data: {
          metadata: { ...metadata, emailed: true },
        },
      });
    }
  }

  if (options.notify !== false) {
    void sendPushToUser(userId, {
      title: 'Your weekly briefing is ready',
      body: briefing.summary.slice(0, 140),
      data: { screen: 'insights' },
    });
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
