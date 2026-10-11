import type { Queue } from 'bullmq';
import prisma from '../config/prisma';
import { logger } from '../config/logger';
import { expenseParseQueue, EXPENSE_PARSE_QUEUE } from '../queues/expenseParse.queue';
import {
  categoryBudgetParseQueue,
  CATEGORY_BUDGET_PARSE_QUEUE,
} from '../queues/categoryBudgetParse.queue';
import { briefingQueue, BRIEFING_QUEUE } from '../queues/briefing.queue';
import { recurringQueue, RECURRING_QUEUE } from '../queues/recurring.queue';
import { findBillingDriftUsers } from './admin.service';
import { getAiHealthToday } from './aiMetrics.service';
import { getAiMarginReport } from './aiMargin.service';
import { probeGeminiModels } from './gemini.service';
import { readLastBackupSuccess } from './backupStorage.service';
import { setAlertState, type AlertMessage } from './alerts.service';
import { getRedisClient } from '../config/redis';

/**
 * Periodic ops checks (run by the ops-monitor queue, every 15 min by default).
 * Each check reports whether its condition is firing; alerts.service turns that
 * into Telegram messages on start / reminder / resolve.
 */

export interface CheckResult {
  key: string;
  firing: boolean;
  message: AlertMessage;
}

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Look back a bit further than the schedule so nothing falls between two runs. */
const WINDOW_MS = 30 * 60 * 1000;

/** Failures that are expected user behaviour, not incidents. */
const IGNORED_FAILURES = [/Import cancelled by user/i];

const QUEUES: Array<{ name: string; queue: Queue; maxFailures: number }> = [
  {
    name: EXPENSE_PARSE_QUEUE,
    queue: expenseParseQueue,
    maxFailures: num('ALERT_QUEUE_FAILURES', 5),
  },
  {
    name: CATEGORY_BUDGET_PARSE_QUEUE,
    queue: categoryBudgetParseQueue,
    maxFailures: num('ALERT_QUEUE_FAILURES', 5),
  },
  { name: BRIEFING_QUEUE, queue: briefingQueue, maxFailures: num('ALERT_QUEUE_FAILURES', 5) },
  // Recurring sweep logs users' expenses — any failure matters.
  { name: RECURRING_QUEUE, queue: recurringQueue, maxFailures: 1 },
];

export async function checkDatabase(): Promise<CheckResult> {
  const message: AlertMessage = { severity: 'critical', title: 'Database unreachable' };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { key: 'database', firing: false, message };
  } catch (err) {
    message.lines = [err instanceof Error ? err.message.slice(0, 200) : String(err)];
    return { key: 'database', firing: true, message };
  }
}

export async function checkWebhookErrors(): Promise<CheckResult> {
  const since = new Date(Date.now() - WINDOW_MS);
  const rows = await prisma.billingWebhookEvent.findMany({
    where: { outcome: 'error', createdAt: { gte: since } },
    select: { eventType: true },
  });
  const types = [...new Set(rows.map((r) => r.eventType))].join(', ');
  return {
    key: 'webhook_errors',
    firing: rows.length > 0,
    message: {
      severity: 'critical',
      title: 'RevenueCat webhooks failing',
      lines: [
        `${rows.length} failed in the last 30 min (${types || '—'})`,
        'Check Admin → Billing ops.',
      ],
    },
  };
}

async function checkUnmappedWebhooks(): Promise<CheckResult> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await prisma.billingWebhookEvent.count({
    where: { outcome: 'unmapped', createdAt: { gte: since } },
  });
  return {
    key: 'webhook_unmapped',
    firing: count > 0,
    message: {
      severity: 'warning',
      title: 'Purchases not linked to a user',
      lines: [
        `${count} RevenueCat event(s) in 24h matched no user — someone may have paid without getting premium.`,
      ],
    },
  };
}

async function checkBillingDrift(): Promise<CheckResult> {
  const drift = await findBillingDriftUsers();
  const min = num('ALERT_BILLING_DRIFT_MIN', 1);
  return {
    key: 'billing_drift',
    firing: drift.length >= min,
    message: {
      severity: 'warning',
      title: 'Premium flags out of sync',
      lines: [
        `${drift.length} user(s) whose premium flag disagrees with their subscription.`,
        'Review in Admin → Billing ops.',
      ],
    },
  };
}

async function checkAi(): Promise<CheckResult[]> {
  const ai = await getAiHealthToday();
  const maxUsd = num('ALERT_AI_DAILY_USD', 5);
  const maxRatio = num('ALERT_AI_FALLBACK_RATIO', 0.25);
  const ratio = ai.calls > 0 ? ai.fallbacks / ai.calls : 0;
  return [
    {
      key: 'ai_daily_spend',
      firing: ai.costUsd > maxUsd,
      message: {
        severity: 'warning',
        title: 'AI spend over daily limit',
        lines: [
          `$${ai.costUsd.toFixed(2)} today (UTC) across ${ai.calls.toLocaleString()} calls; limit $${maxUsd}.`,
        ],
      },
    },
    {
      key: 'ai_fallbacks',
      firing: ai.calls >= 20 && ratio > maxRatio,
      message: {
        severity: 'warning',
        title: 'Gemini falling back often',
        lines: [
          `${ai.fallbacks} of ${ai.calls} calls today (${Math.round(ratio * 100)}%) weren't served by the primary model/key.`,
          'Check the server log for "rate-limited" (quota) or "unavailable" (retired model).',
        ],
      },
    },
  ];
}

const MODEL_PROBE_KEY = 'ops:ai_models';
const MODEL_PROBE_EVERY_MS = 60 * 60 * 1000;

/** Retired models silently turn every call into a fallback chain — catch them directly. Probed hourly. */
async function checkAiModels(): Promise<CheckResult> {
  const client = getRedisClient();
  type Probe = Awaited<ReturnType<typeof probeGeminiModels>>;
  let probe: Probe | null = null;
  const cached = await client.get(MODEL_PROBE_KEY);
  if (cached) {
    const { at, results } = JSON.parse(cached) as { at: number; results: Probe };
    // Ignore entries cached by an older deploy whose probe shape lacked `sources`.
    const current = Array.isArray(results) && results.every((r) => Array.isArray(r?.sources));
    if (current && Date.now() - at < MODEL_PROBE_EVERY_MS) probe = results;
  }
  if (!probe) {
    probe = await probeGeminiModels();
    await client.set(MODEL_PROBE_KEY, JSON.stringify({ at: Date.now(), results: probe }));
  }

  const gone = probe.filter((p) => !p.ok);
  // Calls still succeed while each key has a live model (gemini.service skips gone ones), so a
  // retired entry is config hygiene, not an outage — unless a key has nothing left to serve.
  const keyDown = (['primary', 'backup'] as const).some((label) => {
    const forKey = probe!.filter((p) => p.label === label);
    return forKey.length > 0 && forKey.every((p) => !p.ok);
  });
  return {
    key: 'ai_models',
    firing: gone.length > 0,
    message: {
      severity: keyDown ? 'critical' : 'warning',
      title: keyDown
        ? 'Gemini unavailable — no working model'
        : 'Gemini model retired — update config',
      lines: [
        ...gone.map((g) => `${g.model} (${g.label} key) — set in ${g.sources.join(', ')}`),
        keyDown
          ? 'AI features are failing. Point the variables above at gemini-flash-latest and restart.'
          : 'AI still works via fallbacks. Remove or replace it in the server .env and restart.',
      ],
    },
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Users whose AI cost this month outruns what they pay (free users: over ALERT_FREE_USER_AI_USD). */
export async function checkAiUserMargin(): Promise<CheckResult> {
  const report = await getAiMarginReport('month', 'cost', Number.MAX_SAFE_INTEGER);
  const flagged = report.rows.filter((r) => r.flag);
  return {
    key: 'ai_user_margin',
    firing: flagged.length > 0,
    message: {
      severity: 'warning',
      title: 'Users costing more AI than they pay',
      lines: [
        ...flagged.slice(0, 3).map((r) => {
          const who = r.user?.email ?? `deleted ${r.userId.slice(0, 8)}`;
          return r.flag === 'free_high_cost'
            ? `${who} — free, ${usd(r.costUsd)} AI this month`
            : `${who} — ${usd(r.costUsd)} AI vs ${usd(r.revenueUsd)} paid this month`;
        }),
        ...(flagged.length > 3 ? [`…and ${flagged.length - 3} more.`] : []),
        'Review in Admin → Operations → Top AI users.',
      ],
    },
  };
}

async function checkQueues(): Promise<CheckResult[]> {
  const since = Date.now() - WINDOW_MS;
  const maxBacklog = num('ALERT_QUEUE_BACKLOG', 200);
  const results: CheckResult[] = [];

  for (const { name, queue, maxFailures } of QUEUES) {
    const [failed, counts] = await Promise.all([
      queue.getFailed(0, 199),
      queue.getJobCounts('waiting', 'delayed'),
    ]);
    const recent = failed.filter(
      (j) =>
        (j.finishedOn ?? 0) >= since &&
        !IGNORED_FAILURES.some((re) => re.test(j.failedReason ?? ''))
    );
    const sample = recent[0]?.failedReason?.slice(0, 200);
    results.push({
      key: `queue_failures:${name}`,
      firing: recent.length >= maxFailures,
      message: {
        severity: name === RECURRING_QUEUE ? 'critical' : 'warning',
        title: `Jobs failing: ${name}`,
        lines: [
          `${recent.length} failed in the last 30 min.`,
          ...(sample ? [`Latest: ${sample}`] : []),
        ],
      },
    });
    const backlog = (counts.waiting ?? 0) + (counts.delayed ?? 0);
    results.push({
      key: `queue_backlog:${name}`,
      firing: backlog > maxBacklog,
      message: {
        severity: 'warning',
        title: `Queue backing up: ${name}`,
        lines: [`${backlog} jobs waiting — workers may be stuck.`],
      },
    });
  }
  return results;
}

/** Only checked once backup-db.sh has written its success marker on this host. */
async function checkBackup(): Promise<CheckResult | null> {
  const last = await readLastBackupSuccess();
  if (!last) return null; // no backups on this host (e.g. local dev)
  const mtimeMs = last.getTime();
  const maxHours = num('ALERT_BACKUP_MAX_AGE_HOURS', 26);
  const ageHours = (Date.now() - mtimeMs) / 3_600_000;
  return {
    key: 'backup_stale',
    firing: ageHours > maxHours,
    message: {
      severity: 'critical',
      title: 'Database backup is overdue',
      lines: [`Last successful backup ${Math.round(ageHours)}h ago (limit ${maxHours}h).`],
    },
  };
}

/**
 * A stalled dependency must not hang the run: BullMQ's Redis connection retries
 * forever, and the monitor worker runs one job at a time, so one stuck check
 * would silently stop every later run.
 */
const CHECK_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function safely<T>(name: string, fn: () => Promise<T>): Promise<T | CheckResult> {
  try {
    return await withTimeout(fn(), CHECK_TIMEOUT_MS);
  } catch (err) {
    logger.warn({ err, check: name }, 'Ops check failed');
    return {
      key: `check_error:${name}`,
      firing: true,
      message: {
        severity: 'warning',
        title: `Monitor check failed: ${name}`,
        lines: [err instanceof Error ? err.message.slice(0, 200) : String(err)],
      },
    };
  }
}

/** Evaluate every check. Exported separately from notification for testing. */
export async function runOpsChecks(): Promise<CheckResult[]> {
  const db = await checkDatabase();
  // Every other check reads the database; don't bury the real problem in follow-on failures.
  if (db.firing) return [db];

  const settled = await Promise.all([
    safely('webhook_errors', checkWebhookErrors),
    safely('webhook_unmapped', checkUnmappedWebhooks),
    safely('billing_drift', checkBillingDrift),
    safely('ai', checkAi),
    safely('ai_models', checkAiModels),
    safely('ai_user_margin', checkAiUserMargin),
    safely('queues', checkQueues),
    safely('backup', checkBackup),
  ]);

  const results: CheckResult[] = [db];
  for (const r of settled) {
    if (Array.isArray(r)) results.push(...r);
    else if (r) results.push(r);
  }
  // Clear any previous "check failed" alert for checks that ran fine this time.
  const names = [
    'webhook_errors',
    'webhook_unmapped',
    'billing_drift',
    'ai',
    'ai_models',
    'ai_user_margin',
    'queues',
    'backup',
  ];
  for (const name of names) {
    const key = `check_error:${name}`;
    if (!results.some((r) => r.key === key)) {
      results.push({
        key,
        firing: false,
        message: { severity: 'warning', title: `Monitor check failed: ${name}` },
      });
    }
  }
  return results;
}

export const MONITOR_LAST_RUN_KEY = 'ops:monitor:last_run';

export async function getMonitorLastRun(): Promise<{
  at: string;
  checks: number;
  firing: number;
} | null> {
  const raw = await getRedisClient().get(MONITOR_LAST_RUN_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function runOpsMonitor(): Promise<{ firing: string[] }> {
  const results = await runOpsChecks();
  for (const r of results) await setAlertState(r.key, r.firing, r.message);
  const firing = results.filter((r) => r.firing).map((r) => r.key);
  try {
    await getRedisClient().set(
      MONITOR_LAST_RUN_KEY,
      JSON.stringify({
        at: new Date().toISOString(),
        checks: results.length,
        firing: firing.length,
      })
    );
  } catch (err) {
    logger.debug({ err }, 'Could not record ops monitor run');
  }
  return { firing };
}
