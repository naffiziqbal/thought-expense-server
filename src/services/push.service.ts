/**
 * Expo push delivery. Tokens come from the mobile app (see
 * POST /api/notifications/register) and are pruned when Expo reports them
 * as unregistered, so uninstalled apps stop costing us requests.
 */

import * as Sentry from '@sentry/node';
import prisma from '../config/prisma';
import { logger } from '../config/logger';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;
const EXPO_TIMEOUT_MS = 15_000;

export interface PushPayload {
  title: string;
  body: string;
  /** Routed by the app to a screen, e.g. { screen: 'budget' } */
  data?: Record<string, unknown>;
}

export type SendPushResult = {
  delivered: number;
  reason: 'sent' | 'disabled' | 'no_devices' | 'failed';
};

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function deliver(
  tokens: string[],
  payload: PushPayload
): Promise<{ delivered: number; dead: string[] }> {
  const messages = tokens.map((to) => ({
    to,
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    sound: 'default' as const,
    channelId: 'default',
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(process.env.EXPO_ACCESS_TOKEN
        ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Expo push failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { data?: ExpoTicket[] };
  const tickets = json.data ?? [];

  const dead: string[] = [];
  let delivered = 0;

  // Expo returns tickets positionally, so index maps back to the token.
  tickets.forEach((ticket, i) => {
    if (ticket.status === 'ok') {
      delivered += 1;
      return;
    }
    if (ticket.details?.error === 'DeviceNotRegistered' && tokens[i]) {
      dead.push(tokens[i]);
    }
  });

  return { delivered, dead };
}

/**
 * Push to every device of one user. Never throws — notification failure must
 * not break the request or job that triggered it.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<SendPushResult> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pushEnabled: true },
    });
    if (!user || !user.pushEnabled) return { delivered: 0, reason: 'disabled' };

    const devices = await prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    if (devices.length === 0) return { delivered: 0, reason: 'no_devices' };

    const tokens = devices.map((d) => d.token);
    const dead: string[] = [];
    let delivered = 0;

    for (const group of chunk(tokens, BATCH_SIZE)) {
      const batch = await deliver(group, payload);
      delivered += batch.delivered;
      dead.push(...batch.dead);
    }

    if (dead.length > 0) {
      await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
      logger.info({ userId, count: dead.length }, 'Pruned unregistered push tokens');
    }

    if (delivered === 0) {
      const error = new Error('Expo accepted no push tickets for this user');
      logger.error({ userId, tokenCount: tokens.length }, error.message);
      Sentry.captureException(error, { extra: { userId, tokenCount: tokens.length } });
      return { delivered: 0, reason: 'failed' };
    }

    return { delivered, reason: 'sent' };
  } catch (error) {
    logger.error({ err: error, userId }, 'Push notification failed');
    Sentry.captureException(error, { extra: { userId } });
    return { delivered: 0, reason: 'failed' };
  }
}
