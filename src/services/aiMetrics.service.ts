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
