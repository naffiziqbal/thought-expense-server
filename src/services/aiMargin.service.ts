/**
 * AI cost vs subscription revenue per user — who costs more than they pay.
 * Cost comes from the Redis AI rollups (aiMetrics), revenue from RevenueCat webhook rows.
 */

import prisma from '../config/prisma';
import { getTopAiUsers, type TopAiUserRow, type TopAiUsersPeriod } from './aiMetrics.service';

export type AiMarginSort = 'cost' | 'tokens' | 'margin';

export type AiMarginFlag = 'free_high_cost' | 'cost_exceeds_revenue';

export interface AiMarginRow extends TopAiUserRow {
  revenueUsd: number;
  marginUsd: number;
  flag: AiMarginFlag | null;
  user: { id: string; email: string; name: string | null; isPremium: boolean } | null;
}

export interface AiMarginReport {
  period: TopAiUsersPeriod;
  month: string | null;
  sort: AiMarginSort;
  /** Monthly AI cost above which a free user is flagged. */
  freeUserThresholdUsd: number;
  summary: { users: number; aiCostUsd: number; revenueUsd: number; flagged: number };
  rows: AiMarginRow[];
}

/** Events that carry the price of a charge; refunds arrive as negative prices on other types. */
const CHARGE_EVENTS = ['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE'];

export function freeUserThresholdUsd(): number {
  const v = Number(process.env.ALERT_FREE_USER_AI_USD);
  return Number.isFinite(v) && v > 0 ? v : 0.5;
}

function periodRange(month: string | null): { gte: Date; lt: Date } | undefined {
  if (!month) return undefined;
  const [y, m] = month.split('-').map(Number);
  return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
}

/** Net production revenue (charges minus refunds) per user. */
async function revenueByUser(
  userIds: string[],
  month: string | null
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const groups = await prisma.billingWebhookEvent.groupBy({
    by: ['userId'],
    where: {
      userId: { in: userIds },
      // Retried deliveries are logged as 'duplicate'; only the processed row counts.
      outcome: 'processed',
      priceUsd: { not: null },
      createdAt: periodRange(month),
      AND: [
        { OR: [{ eventType: { in: CHARGE_EVENTS } }, { priceUsd: { lt: 0 } }] },
        { OR: [{ environment: null }, { environment: { not: 'SANDBOX' } }] },
      ],
    },
    _sum: { priceUsd: true },
  });
  return new Map(groups.map((g) => [g.userId!, g._sum.priceUsd ?? 0]));
}

export function marginFlag(
  row: { costUsd: number; revenueUsd: number; isPremium: boolean | null },
  monthly: boolean,
  thresholdUsd: number
): AiMarginFlag | null {
  if (row.revenueUsd > 0 && row.costUsd > row.revenueUsd) return 'cost_exceeds_revenue';
  // The threshold is per month, so it doesn't apply to all-time totals.
  if (monthly && row.isPremium === false && row.costUsd >= thresholdUsd) return 'free_high_cost';
  return null;
}

export async function getAiMarginReport(
  period: TopAiUsersPeriod,
  sort: AiMarginSort,
  limit: number
): Promise<AiMarginReport> {
  const top = await getTopAiUsers(
    period,
    sort === 'tokens' ? 'tokens' : 'cost',
    Number.MAX_SAFE_INTEGER
  );
  const ids = top.rows.map((r) => r.userId);
  const [users, revenue] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, name: true, isPremium: true },
    }),
    revenueByUser(ids, top.month),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const threshold = freeUserThresholdUsd();

  const rows: AiMarginRow[] = top.rows.map((r) => {
    // Deleted accounts keep their usage rollups, so the user can be missing.
    const user = byId.get(r.userId) ?? null;
    const revenueUsd = Math.round((revenue.get(r.userId) ?? 0) * 100) / 100;
    return {
      ...r,
      user,
      revenueUsd,
      marginUsd: revenueUsd - r.costUsd,
      flag: marginFlag(
        { costUsd: r.costUsd, revenueUsd, isPremium: user?.isPremium ?? null },
        top.month !== null,
        threshold
      ),
    };
  });
  if (sort === 'margin') rows.sort((a, b) => a.marginUsd - b.marginUsd);

  return {
    period,
    month: top.month,
    sort,
    freeUserThresholdUsd: threshold,
    summary: {
      users: rows.length,
      aiCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
      revenueUsd: rows.reduce((s, r) => s + r.revenueUsd, 0),
      flagged: rows.filter((r) => r.flag).length,
    },
    rows: rows.slice(0, limit),
  };
}
