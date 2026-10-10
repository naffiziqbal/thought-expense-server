import { getRedisClient } from '../config/redis';
import { logger } from '../config/logger';
import {
  AI_PRICING,
  NANO_USD,
  costNanoUsd,
  normalizeModelName,
  priceForModel,
  type ModelPrice,
} from '../config/aiPricing';

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

function userLifetimeKey(userId: string): string {
  return `metrics:ai:u:${userId}:all`;
}

function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Per-user monthly rollup — no TTL, so month-over-month cost history is kept. */
function userMonthKey(userId: string, month: string): string {
  return `metrics:ai:u:${userId}:m:${month}`;
}

/** All-users daily cost (95-day TTL) — feeds the daily AI spend alert. */
function globalDayKey(day: string): string {
  return `metrics:ai:day:${day}`;
}

/** All-users monthly rollup — no TTL, survives account deletion. */
function globalMonthKey(month: string): string {
  return `metrics:ai:month:${month}`;
}

export interface AiCallUsage {
  /** Model that actually served the call (after fallbacks). */
  model: string;
  inputTokens: number;
  /** Candidates + thinking tokens (both billed as output). */
  outputTokens: number;
}

/**
 * Per-user AI usage. Day hash (95-day TTL) fields:
 *   <kind>:calls|tokens|in|out|cost, m:<model>:calls|in|out|cost, total:tokens|cost
 * Lifetime hash (no TTL): calls, in, out, cost, since.
 * Monthly hashes (no TTL), per user and across all users: calls, in, out, cost, <kind>:calls, <kind>:cost.
 * Cost is stored in nano-USD at list price (see config/aiPricing).
 */
export async function recordUserAiUsage(
  userId: string,
  kind: AiMetricKind,
  usage: AiCallUsage
): Promise<void> {
  if (!userId) return;
  try {
    const client = getRedisClient();
    const model = normalizeModelName(usage.model);
    const input = Math.max(0, Math.round(usage.inputTokens) || 0);
    const output = Math.max(0, Math.round(usage.outputTokens) || 0);
    const tokens = input + output;
    const cost = costNanoUsd(model, input, output);
    const key = userDayKey(userId, dayKey());
    const lifetime = userLifetimeKey(userId);
    const month = monthKey();

    const multi = client
      .multi()
      .hIncrBy(key, `${kind}:calls`, 1)
      .hIncrBy(key, `${kind}:tokens`, tokens)
      .hIncrBy(key, `${kind}:in`, input)
      .hIncrBy(key, `${kind}:out`, output)
      .hIncrBy(key, `${kind}:cost`, cost)
      .hIncrBy(key, `m:${model}:calls`, 1)
      .hIncrBy(key, `m:${model}:in`, input)
      .hIncrBy(key, `m:${model}:out`, output)
      .hIncrBy(key, `m:${model}:cost`, cost)
      .hIncrBy(key, 'total:tokens', tokens)
      .hIncrBy(key, 'total:cost', cost)
      .expire(key, TTL_SECONDS)
      .hIncrBy(lifetime, 'calls', 1)
      .hIncrBy(lifetime, 'in', input)
      .hIncrBy(lifetime, 'out', output)
      .hIncrBy(lifetime, 'cost', cost)
      .hSetNX(lifetime, 'since', new Date().toISOString());
    const globalDay = globalDayKey(dayKey());
    multi
      .hIncrBy(globalDay, 'calls', 1)
      .hIncrBy(globalDay, 'cost', cost)
      .expire(globalDay, TTL_SECONDS);
    for (const monthly of [userMonthKey(userId, month), globalMonthKey(month)]) {
      multi
        .hIncrBy(monthly, 'calls', 1)
        .hIncrBy(monthly, 'in', input)
        .hIncrBy(monthly, 'out', output)
        .hIncrBy(monthly, 'cost', cost)
        .hIncrBy(monthly, `${kind}:calls`, 1)
        .hIncrBy(monthly, `${kind}:cost`, cost);
    }
    await multi.exec();
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

/** Today's (UTC) AI health across all users, for ops alerts. */
export async function getAiHealthToday(): Promise<{
  calls: number;
  fallbacks: number;
  /** Cost of user-attributed calls (cron jobs without a user aren't priced). */
  costUsd: number;
}> {
  const client = getRedisClient();
  const day = dayKey();
  const multi = client.multi();
  for (const kind of AI_METRIC_KINDS) multi.get(usageKey(kind, day));
  multi.get(fallbackKey(day));
  multi.hGet(globalDayKey(day), 'cost');
  const res = (await multi.exec()) as unknown as Array<string | null>;
  const calls = res
    .slice(0, AI_METRIC_KINDS.length)
    .reduce((sum, v) => sum + (parseInt(v ?? '0', 10) || 0), 0);
  const fallbacks = parseInt(res[AI_METRIC_KINDS.length] ?? '0', 10) || 0;
  const costUsd = (parseInt(res[AI_METRIC_KINDS.length + 1] ?? '0', 10) || 0) / NANO_USD;
  return { calls, fallbacks, costUsd };
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

export interface AiUsageStats {
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type UserAiUsageByKind = Record<string, AiUsageStats>;

function emptyStats(): AiUsageStats {
  return { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function addStats(into: AiUsageStats, from: AiUsageStats): void {
  into.calls += from.calls;
  into.tokens += from.tokens;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.costUsd += from.costUsd;
}

/**
 * Tokens recorded before the input/output split existed have no cost attached.
 * Estimate them at the default parsing model with a typical 85/15 input/output mix.
 */
const LEGACY_MODEL = process.env.PARSING_MODEL || 'gemini-flash-latest';
const LEGACY_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';

function legacyCostUsd(kind: string, tokens: number): number {
  if (tokens <= 0) return 0;
  if (kind === 'embedding') return costNanoUsd(LEGACY_EMBEDDING_MODEL, tokens, 0) / NANO_USD;
  const input = Math.round(tokens * 0.85);
  return costNanoUsd(LEGACY_MODEL, input, tokens - input) / NANO_USD;
}

function parseUserDayHash(raw: Record<string, string>): {
  byKind: UserAiUsageByKind;
  byModel: UserAiUsageByKind;
  totals: AiUsageStats;
  legacyCostUsd: number;
} {
  const byKind: UserAiUsageByKind = {};
  const byModel: UserAiUsageByKind = {};

  for (const [field, value] of Object.entries(raw)) {
    const n = parseInt(value, 10) || 0;
    const sep = field.lastIndexOf(':');
    if (sep <= 0) continue;
    const name = field.slice(0, sep);
    const metric = field.slice(sep + 1);
    if (name === 'total') continue;

    const isModel = name.startsWith('m:');
    const bucket = isModel ? byModel : byKind;
    const id = isModel ? name.slice(2) : name;
    const stats = (bucket[id] ??= emptyStats());
    if (metric === 'calls') stats.calls = n;
    else if (metric === 'tokens') stats.tokens = n;
    else if (metric === 'in') stats.inputTokens = n;
    else if (metric === 'out') stats.outputTokens = n;
    else if (metric === 'cost') stats.costUsd = n / NANO_USD;
  }

  let legacy = 0;
  for (const [kind, stats] of Object.entries(byKind)) {
    const untracked = stats.tokens - stats.inputTokens - stats.outputTokens;
    if (untracked > 0) {
      const est = legacyCostUsd(kind, untracked);
      stats.costUsd += est;
      legacy += est;
    }
  }
  for (const stats of Object.values(byModel)) {
    stats.tokens = stats.inputTokens + stats.outputTokens;
  }

  const totals = emptyStats();
  for (const stats of Object.values(byKind)) addStats(totals, stats);

  return { byKind, byModel, totals, legacyCostUsd: legacy };
}

export interface UserAiUsageSummary {
  days: number;
  totals: AiUsageStats & {
    /** Part of costUsd estimated from token totals recorded before the input/output split. */
    legacyCostUsd: number;
    activeDays: number;
  };
  byKind: UserAiUsageByKind;
  byModel: Record<string, AiUsageStats & { priced: boolean }>;
  series: Array<{
    date: string;
    totalCalls: number;
    totalTokens: number;
    costUsd: number;
    byKind: UserAiUsageByKind;
  }>;
  /** All-time totals since cost tracking started for this user (not TTL-limited). */
  lifetime: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    since: string | null;
  } | null;
  /** Last 12 calendar months from the permanent monthly rollup (oldest first). */
  monthly: Array<{ month: string; calls: number; costUsd: number }>;
  pricing: Record<string, ModelPrice>;
}

function lastMonths(n: number): string[] {
  const months: string[] = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    months.push(monthKey(m));
  }
  return months;
}

/** All-time AI usage for one user (used when archiving a deleted account). */
export async function getUserAiLifetime(
  userId: string
): Promise<{ calls: number; costUsd: number }> {
  try {
    const raw = await getRedisClient().hGetAll(userLifetimeKey(userId));
    return {
      calls: parseInt(raw.calls, 10) || 0,
      costUsd: (parseInt(raw.cost, 10) || 0) / NANO_USD,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'getUserAiLifetime failed');
    return { calls: 0, costUsd: 0 };
  }
}

export async function getUserAiUsageSummary(
  userId: string,
  days: number
): Promise<UserAiUsageSummary> {
  const series: UserAiUsageSummary['series'] = [];
  const byKind: UserAiUsageByKind = {};
  const byModel: UserAiUsageSummary['byModel'] = {};
  const totals = { ...emptyStats(), legacyCostUsd: 0, activeDays: 0 };
  let lifetime: UserAiUsageSummary['lifetime'] = null;
  const months = lastMonths(12);
  const monthly: UserAiUsageSummary['monthly'] = months.map((month) => ({
    month,
    calls: 0,
    costUsd: 0,
  }));

  try {
    const client = getRedisClient();
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(dayKey(d));
    }
    const multi = client.multi();
    for (const date of dates) multi.hGetAll(userDayKey(userId, date));
    multi.hGetAll(userLifetimeKey(userId));
    for (const month of months) multi.hGetAll(userMonthKey(userId, month));
    const results = (await multi.exec()) as unknown as Array<Record<string, string>>;

    dates.forEach((date, idx) => {
      const raw = results[idx] ?? {};
      const day = parseUserDayHash(raw);

      for (const [kind, stats] of Object.entries(day.byKind)) {
        addStats((byKind[kind] ??= emptyStats()), stats);
      }
      for (const [model, stats] of Object.entries(day.byModel)) {
        addStats(
          (byModel[model] ??= { ...emptyStats(), priced: priceForModel(model).known }),
          stats
        );
      }
      addStats(totals, day.totals);
      totals.legacyCostUsd += day.legacyCostUsd;
      if (day.totals.calls > 0) totals.activeDays += 1;

      series.push({
        date,
        totalCalls: day.totals.calls,
        totalTokens: day.totals.tokens,
        costUsd: day.totals.costUsd,
        byKind: day.byKind,
      });
    });

    const lt = results[dates.length] ?? {};
    if (Object.keys(lt).length > 0) {
      lifetime = {
        calls: parseInt(lt.calls, 10) || 0,
        inputTokens: parseInt(lt.in, 10) || 0,
        outputTokens: parseInt(lt.out, 10) || 0,
        costUsd: (parseInt(lt.cost, 10) || 0) / NANO_USD,
        since: lt.since ?? null,
      };
    }
    months.forEach((_, i) => {
      const raw = results[dates.length + 1 + i] ?? {};
      monthly[i].calls = parseInt(raw.calls, 10) || 0;
      monthly[i].costUsd = (parseInt(raw.cost, 10) || 0) / NANO_USD;
    });
  } catch (err) {
    logger.warn({ err, userId }, 'getUserAiUsageSummary failed');
  }

  return { days, totals, byKind, byModel, series, lifetime, monthly, pricing: AI_PRICING };
}
