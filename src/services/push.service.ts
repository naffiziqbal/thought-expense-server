/**
 * Expo push delivery. Tokens come from the mobile app (see
 * POST /api/notifications/register) and are pruned when Expo reports them
 * as unregistered, so uninstalled apps stop costing us requests.
 */

import prisma from '../config/prisma';
import { logger } from '../config/logger';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;

export interface PushPayload {
  title: string;
  body: string;
  /** Routed by the app to a screen, e.g. { screen: 'budget' } */
  data?: Record<string, unknown>;
}

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

async function deliver(tokens: string[], payload: PushPayload): Promise<string[]> {
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
  });

  if (!response.ok) {
    throw new Error(`Expo push failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { data?: ExpoTicket[] };
  const tickets = json.data ?? [];

  // Expo returns tickets positionally, so index maps back to the token.
  return tickets
    .map((ticket, i) => (ticket.details?.error === 'DeviceNotRegistered' ? tokens[i] : null))
    .filter((token): token is string => Boolean(token));
}

/**
 * Push to every device of one user. Never throws — notification failure must
 * not break the request or job that triggered it.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pushEnabled: true },
    });
    if (!user || !user.pushEnabled) return 0;

    const devices = await prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    if (devices.length === 0) return 0;

    const tokens = devices.map((d) => d.token);
    const dead: string[] = [];

    for (const group of chunk(tokens, BATCH_SIZE)) {
      dead.push(...(await deliver(group, payload)));
    }

    if (dead.length > 0) {
      await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
      logger.info({ userId, count: dead.length }, 'Pruned unregistered push tokens');
    }

    return tokens.length - dead.length;
  } catch (error) {
    logger.error({ err: error, userId }, 'Push notification failed');
    return 0;
  }
}
