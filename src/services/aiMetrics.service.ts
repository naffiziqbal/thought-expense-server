import { getRedisClient } from '../config/redis';
import { logger } from '../config/logger';

export const AI_METRIC_KINDS = [
  'parse',
  'parse_async',
  'ocr',
  'insights',
  'briefing',
  'advisor_ask',
  'advisor_why',
  'advisor_savings',
  'search',
  'embedding',
  'budget_category',
] as const;

export type AiMetricKind = (typeof AI_METRIC_KINDS)[number];

const TTL_SECONDS = 60 * 60 * 24 * 95; // ~95 days

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function usageKey(kind: AiMetricKind, day: string): string {
  return `metrics:ai:${kind}:${day}`;
}

function fallbackKey(day: string): string {
  return `metrics:ai:fallback:${day}`;
}

function userDayKey(userId: string, day: string): string {
  return `metrics:ai:u:${userId}:${day}`;
}

export type UserAiUsageByKind = Record<string, { calls: number; tokens: number }>;

export async function recordUserAiUsage(
  userId: string,
  kind: AiMetricKind,
  tokens = 0
): Promise<void> {
  if (!userId) return;
  try {
    const client = getRedisClient();
    const key = userDayKey(userId, dayKey());
    await client.hIncrBy(key, `${kind}:calls`, 1);
    if (tokens > 0) {
      await client.hIncrBy(key, `${kind}:tokens`, tokens);
      await client.hIncrBy(key, 'total:tokens', tokens);
    }
    await client.expire(key, TTL_SECONDS);
  } catch (err) {
    logger.debug({ err, kind, userId }, 'recordUserAiUsage failed');
  }
}

export async function recordAiUsage(kind: AiMetricKind, count = 1): Promise<void> {
  try {
    const client = getRedisClient();
    const key = usageKey(kind, dayKey());
    await client.incrBy(key, count);
    await client.expire(key, TTL_SECONDS);
  } catch (err) {
    logger.debug({ err, kind }, 'recordAiUsage failed');
  }
}

export async function recordAiFallback(count = 1): Promise<void> {
  try {
    const client = getRedisClient();
    const key = fallbackKey(dayKey());
    await client.incrBy(key, count);
    await client.expire(key, TTL_SECONDS);
  } catch (err) {
    logger.debug({ err }, 'recordAiFallback failed');
  }
}

export async function getAiUsageSeries(days: number): Promise<{
  series: Array<{ date: string; total: number; byKind: Record<string, number> }>;
  totals: Record<string, number>;
  fallbacks: Record<string, number>;
}> {
  const series: Array<{ date: string; total: number; byKind: Record<string, number> }> = [];
  const totals: Record<string, number> = {};
  const fallbacks: Record<string, number> = {};

  try {
    const client = getRedisClient();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const date = dayKey(d);
      const byKind: Record<string, number> = {};
      let total = 0;
      for (const kind of AI_METRIC_KINDS) {
        const raw = await client.get(usageKey(kind, date));
        const n = raw ? parseInt(raw, 10) : 0;
        if (n > 0) {
          byKind[kind] = n;
          total += n;
          totals[kind] = (totals[kind] ?? 0) + n;
        }
      }
      const fbRaw = await client.get(fallbackKey(date));
      const fb = fbRaw ? parseInt(fbRaw, 10) : 0;
      if (fb > 0) fallbacks[date] = fb;
      series.push({ date, total, byKind });
    }
  } catch (err) {
    logger.warn({ err }, 'getAiUsageSeries failed');
  }

  return { series, totals, fallbacks };
}

function parseUserDayHash(raw: Record<string, string>): {
  byKind: UserAiUsageByKind;
  totalCalls: number;
  totalTokens: number;
} {
  const byKind: UserAiUsageByKind = {};
  let totalCalls = 0;
  let totalTokens = 0;

  for (const [field, value] of Object.entries(raw)) {
    const n = parseInt(value, 10) || 0;
    if (field === 'total:tokens') {
      totalTokens = n;
      continue;
    }
    const match = /^(.+):calls$/.exec(field);
    if (match) {
      const kind = match[1];
      byKind[kind] = { calls: n, tokens: 0 };
      totalCalls += n;
    }
  }
  for (const [field, value] of Object.entries(raw)) {
    const n = parseInt(value, 10) || 0;
    const match = /^(.+):tokens$/.exec(field);
    if (match) {
      const kind = match[1];
      if (!byKind[kind]) byKind[kind] = { calls: 0, tokens: 0 };
      byKind[kind].tokens = n;
    }
  }
  if (totalTokens === 0) {
    totalTokens = Object.values(byKind).reduce((a, k) => a + k.tokens, 0);
  }

  return { byKind, totalCalls, totalTokens };
}

export async function getUserAiUsageSummary(
  userId: string,
  days: number
): Promise<{
  series: Array<{
    date: string;
    totalCalls: number;
    totalTokens: number;
    byKind: UserAiUsageByKind;
  }>;
  totals: { calls: number; tokens: number };
  byKind: UserAiUsageByKind;
}> {
  const series: Array<{
    date: string;
    totalCalls: number;
    totalTokens: number;
    byKind: UserAiUsageByKind;
  }> = [];
  const byKind: UserAiUsageByKind = {};
  let totalCalls = 0;
  let totalTokens = 0;

  try {
    const client = getRedisClient();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const date = dayKey(d);
      const raw = await client.hGetAll(userDayKey(userId, date));
      const day =
        Object.keys(raw).length > 0
          ? parseUserDayHash(raw)
          : { byKind: {}, totalCalls: 0, totalTokens: 0 };

      for (const [kind, stats] of Object.entries(day.byKind)) {
        if (!byKind[kind]) byKind[kind] = { calls: 0, tokens: 0 };
        byKind[kind].calls += stats.calls;
        byKind[kind].tokens += stats.tokens;
      }
      totalCalls += day.totalCalls;
      totalTokens += day.totalTokens;
      series.push({
        date,
        totalCalls: day.totalCalls,
        totalTokens: day.totalTokens,
        byKind: day.byKind,
      });
    }
  } catch (err) {
    logger.warn({ err, userId }, 'getUserAiUsageSummary failed');
  }

  return { series, totals: { calls: totalCalls, tokens: totalTokens }, byKind };
}
