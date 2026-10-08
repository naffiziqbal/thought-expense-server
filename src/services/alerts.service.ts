import { getRedisClient } from '../config/redis';
import { logger } from '../config/logger';

/**
 * Ops alerts to Telegram (@te_penny_bot).
 *
 * - sendAlert(): one-off events (webhook crashed, token reuse). Deduped per key with a cooldown.
 * - setAlertState(): conditions checked on a schedule. Notifies when a condition starts,
 *   re-notifies while it persists, and sends a ✅ when it clears.
 *
 * Messages carry counts and ids only — never emails or names (Telegram is a third party).
 * Disabled when TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID are unset, and in tests.
 * Never throws: alerting must not break the code path that triggered it.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

const ICONS: Record<AlertSeverity | 'resolved', string> = {
  critical: '🚨',
  warning: '⚠️',
  info: 'ℹ️',
  resolved: '✅',
};

export interface AlertMessage {
  severity: AlertSeverity;
  title: string;
  lines?: string[];
}

function telegramConfig(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
  if (!token || !chatId || process.env.NODE_ENV === 'test') return null;
  return { token, chatId };
}

export function alertsEnabled(): boolean {
  return telegramConfig() !== null;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function envLabel(): string {
  return process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || 'development';
}

export function formatAlert(icon: string, title: string, lines: string[] = []): string {
  const body = lines.map((l) => escapeHtml(l)).join('\n');
  return `${icon} <b>${escapeHtml(title)}</b>${body ? `\n${body}` : ''}\n<i>${escapeHtml(envLabel())}</i>`;
}

/** Low-level send. Returns false (and logs) on any failure. */
export async function sendTelegramMessage(html: string): Promise<boolean> {
  const cfg = telegramConfig();
  if (!cfg) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: html.slice(0, 4000), // Telegram limit is 4096 chars
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      logger.warn({ status: res.status, description: body.description }, 'Telegram alert rejected');
      return false;
    }
    return true;
  } catch (err) {
    // Never log the request URL: it contains the bot token.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Telegram alert failed');
    return false;
  }
}

/** Fallback cooldown when Redis is unavailable. */
const memoryCooldown = new Map<string, number>();

async function acquireCooldown(key: string, seconds: number): Promise<boolean> {
  try {
    const res = await getRedisClient().set(`alert:cd:${key}`, '1', { NX: true, EX: seconds });
    return res === 'OK';
  } catch {
    const now = Date.now();
    const until = memoryCooldown.get(key);
    if (until && until > now) return false;
    memoryCooldown.set(key, now + seconds * 1000);
    return true;
  }
}

/** One-off alert, sent at most once per `cooldownSeconds` for the same key. */
export async function sendAlert(
  key: string,
  message: AlertMessage,
  cooldownSeconds = 60 * 60
): Promise<void> {
  try {
    if (!alertsEnabled()) return;
    if (!(await acquireCooldown(key, cooldownSeconds))) return;
    await sendTelegramMessage(formatAlert(ICONS[message.severity], message.title, message.lines));
  } catch (err) {
    logger.warn({ err, key }, 'sendAlert failed');
  }
}

const RENOTIFY_SECONDS: Record<AlertSeverity, number> = {
  critical: 60 * 60, // remind hourly while a critical condition persists
  warning: 6 * 60 * 60,
  info: 24 * 60 * 60,
};

interface AlertStateRecord {
  since: number;
  notifiedAt: number;
  title: string;
  severity: AlertSeverity;
}

function parseState(key: string, raw: string | null): AlertStateRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'number') {
      // Older format: just the last-notified timestamp.
      return { since: parsed, notifiedAt: parsed, title: key, severity: 'warning' };
    }
    return parsed as AlertStateRecord;
  } catch {
    return null;
  }
}

/**
 * Track a monitored condition. Sends on firing → (reminder while firing) → resolved.
 * State lives in Redis (`alert:state:<key>`, JSON) with no TTL.
 */
export async function setAlertState(
  key: string,
  firing: boolean,
  message: AlertMessage
): Promise<void> {
  try {
    if (!alertsEnabled()) return;
    const client = getRedisClient();
    const stateKey = `alert:state:${key}`;
    const state = parseState(key, await client.get(stateKey));
    const now = Date.now();
    const save = (since: number) =>
      client.set(
        stateKey,
        JSON.stringify({ since, notifiedAt: now, title: message.title, severity: message.severity })
      );

    if (firing) {
      if (!state) {
        if (
          await sendTelegramMessage(
            formatAlert(ICONS[message.severity], message.title, message.lines)
          )
        ) {
          await save(now);
        }
        return;
      }
      if (now - state.notifiedAt >= RENOTIFY_SECONDS[message.severity] * 1000) {
        const lines = [...(message.lines ?? []), 'Still ongoing.'];
        if (await sendTelegramMessage(formatAlert(ICONS[message.severity], message.title, lines))) {
          await save(state.since);
        }
      }
      return;
    }

    if (state) {
      await sendTelegramMessage(formatAlert(ICONS.resolved, `Resolved: ${message.title}`));
      await client.del(stateKey);
    }
  } catch (err) {
    logger.warn({ err, key }, 'setAlertState failed');
  }
}

/** Conditions currently firing (for the admin System page). */
export async function getFiringAlerts(): Promise<
  Array<{ key: string; title: string; severity: AlertSeverity; since: string }>
> {
  const client = getRedisClient();
  const keys: string[] = [];
  for await (const key of client.scanIterator({ MATCH: 'alert:state:*', COUNT: 100 })) {
    keys.push(String(key));
  }
  if (keys.length === 0) return [];
  const values = await client.mGet(keys);
  return keys
    .map((stateKey, i) => {
      const key = stateKey.slice('alert:state:'.length);
      const state = parseState(key, values[i]);
      return state
        ? {
            key,
            title: state.title,
            severity: state.severity,
            since: new Date(state.since).toISOString(),
          }
        : null;
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .sort((a, b) => a.since.localeCompare(b.since));
}
