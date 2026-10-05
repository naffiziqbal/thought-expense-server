import prisma from '../config/prisma';
import { isPineconeReady, getIndex, pineconeIndexName } from './pinecone.service';
import { expenseParseQueue, EXPENSE_PARSE_QUEUE } from '../queues/expenseParse.queue';
import {
  categoryBudgetParseQueue,
  CATEGORY_BUDGET_PARSE_QUEUE,
} from '../queues/categoryBudgetParse.queue';
import { briefingQueue, BRIEFING_QUEUE } from '../queues/briefing.queue';
import { recurringQueue, RECURRING_QUEUE } from '../queues/recurring.queue';
import type { Queue } from 'bullmq';
import { getRedisClient } from '../config/redis';
import { logger } from '../config/logger';

async function queueSnapshot(name: string, queue: Queue) {
  const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  let recentFailed: Array<{ id: string; name: string; failedReason: string; timestamp: number }> =
    [];
  try {
    const failed = await queue.getFailed(0, 9);
    recentFailed = failed.map((j) => ({
      id: j.id ?? '',
      name: j.name,
      failedReason: j.failedReason ?? 'unknown',
      timestamp: j.finishedOn ?? j.processedOn ?? Date.now(),
    }));
  } catch {
    // queue may be unavailable
  }
  return { name, counts, recentFailed };
}

export async function getQueueMonitorStats() {
  const queues = await Promise.all([
    queueSnapshot(EXPENSE_PARSE_QUEUE, expenseParseQueue),
    queueSnapshot(CATEGORY_BUDGET_PARSE_QUEUE, categoryBudgetParseQueue),
    queueSnapshot(BRIEFING_QUEUE, briefingQueue),
    queueSnapshot(RECURRING_QUEUE, recurringQueue),
  ]);
  return { queues, generatedAt: new Date().toISOString() };
}

export async function getRagHealthStats() {
  const [expenseCount, vectorRowCount, usersWithEmbeddingsGroups] = await Promise.all([
    prisma.expense.count(),
    prisma.vector.count(),
    prisma.expense.groupBy({
      by: ['userId'],
      where: { vector: { isNot: null } },
    }),
  ]);

  const pinecone: {
    ready: boolean;
    indexName: string;
    totalVectors: number | null;
    dimension: number | null;
  } = {
    ready: isPineconeReady(),
    indexName: pineconeIndexName(),
    totalVectors: null,
    dimension: null,
  };

  if (pinecone.ready) {
    try {
      const stats = await getIndex().describeIndexStats();
      pinecone.totalVectors = stats.totalRecordCount ?? null;
      pinecone.dimension = stats.dimension ?? null;
    } catch (err) {
      logger.warn({ err }, 'Pinecone stats for admin failed');
      pinecone.ready = false;
    }
  }

  const missingEmbeddings = Math.max(0, expenseCount - vectorRowCount);

  return {
    postgres: {
      expenses: expenseCount,
      vectorRows: vectorRowCount,
      usersWithEmbeddings: usersWithEmbeddingsGroups.length,
      missingEmbeddingsEstimate: missingEmbeddings,
    },
    pinecone,
    generatedAt: new Date().toISOString(),
  };
}

export async function getRedisHealth() {
  try {
    const client = getRedisClient();
    const pong = await client.ping();
    return { ok: pong === 'PONG', message: pong };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'error' };
  }
}

interface RcEntitlement {
  expires_date: string | null;
  product_identifier?: string;
}

interface RcSubscriberResponse {
  subscriber?: {
    entitlements?: Record<string, RcEntitlement>;
  };
}

async function lookupRevenueCatEntitlement(
  secret: string,
  userId: string,
  entitlementId: string
): Promise<
  | { found: false; status: number }
  | { found: true; rcPremium: boolean; expiresDate: string | null; productId: string | null }
> {
  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
    {
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) {
    return { found: false, status: res.status };
  }
  const body = (await res.json()) as RcSubscriberResponse;
  const ent = body.subscriber?.entitlements?.[entitlementId];
  const rcPremium = ent
    ? !ent.expires_date || new Date(ent.expires_date).getTime() > Date.now()
    : false;
  return {
    found: true,
    rcPremium,
    expiresDate: ent?.expires_date ?? null,
    productId: ent?.product_identifier ?? null,
  };
}

export async function getRevenueCatSubscriberForUser(userId: string, dbPremium: boolean) {
  const secret = process.env.REVENUECAT_SECRET_API_KEY?.trim();
  if (!secret) {
    return {
      configured: false as const,
      message: 'Set REVENUECAT_SECRET_API_KEY (RevenueCat secret API key) to compare entitlements.',
    };
  }

  const entitlementId = process.env.REVENUECAT_ENTITLEMENT_ID?.trim() || 'premium';
  try {
    const lookup = await lookupRevenueCatEntitlement(secret, userId, entitlementId);
    if (!lookup.found) {
      const reason =
        lookup.status === 404
          ? dbPremium
            ? 'No RevenueCat subscriber for this app user id'
            : 'No subscriber (expected for free users)'
          : `RevenueCat API returned ${lookup.status}`;
      return {
        configured: true as const,
        entitlementId,
        dbPremium,
        rcPremium: false,
        inSync: !dbPremium,
        subscriberFound: false,
        expiresDate: null,
        productId: null,
        reason,
      };
    }
    const inSync = lookup.rcPremium === dbPremium;
    let reason: string | null = null;
    if (!inSync) {
      reason = lookup.rcPremium
        ? 'RevenueCat entitlement active but DB is not premium'
        : 'DB is premium but RevenueCat entitlement is inactive or missing';
    }
    return {
      configured: true as const,
      entitlementId,
      dbPremium,
      rcPremium: lookup.rcPremium,
      inSync,
      subscriberFound: true,
      expiresDate: lookup.expiresDate,
      productId: lookup.productId,
      reason,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'RevenueCat subscriber lookup failed');
    return {
      configured: true as const,
      entitlementId,
      dbPremium,
      rcPremium: false,
      inSync: false,
      subscriberFound: false,
      expiresDate: null,
      productId: null,
      reason: 'RevenueCat request failed',
    };
  }
}

export async function getRevenueCatSyncCheck(limit = 200) {
  const secret = process.env.REVENUECAT_SECRET_API_KEY?.trim();
  if (!secret) {
    return {
      configured: false as const,
      message: 'Set REVENUECAT_SECRET_API_KEY (RevenueCat secret API key) to compare entitlements.',
    };
  }

  const entitlementId = process.env.REVENUECAT_ENTITLEMENT_ID?.trim() || 'premium';
  const dbPremiumCount = await prisma.user.count({ where: { isPremium: true } });
  const candidates = await prisma.user.findMany({
    where: { isPremium: true },
    select: {
      id: true,
      email: true,
      isPremium: true,
      subscriptionStatus: true,
      subscriptionProductId: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(200, Math.max(1, limit)),
  });

  const mismatches: Array<{
    userId: string;
    email: string;
    dbPremium: boolean;
    rcPremium: boolean;
    reason: string;
  }> = [];
  let rcActiveCount = 0;

  for (const user of candidates) {
    try {
      const lookup = await lookupRevenueCatEntitlement(secret, user.id, entitlementId);
      if (!lookup.found) {
        if (user.isPremium && lookup.status === 404) {
          mismatches.push({
            userId: user.id,
            email: user.email,
            dbPremium: user.isPremium,
            rcPremium: false,
            reason: 'DB premium but no RevenueCat subscriber',
          });
        }
        continue;
      }
      if (lookup.rcPremium) rcActiveCount += 1;
      if (lookup.rcPremium !== user.isPremium) {
        mismatches.push({
          userId: user.id,
          email: user.email,
          dbPremium: user.isPremium,
          rcPremium: lookup.rcPremium,
          reason: lookup.rcPremium
            ? 'RevenueCat active, DB not premium'
            : 'DB premium, RevenueCat inactive',
        });
      }
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'RevenueCat subscriber check failed');
    }
  }

  return {
    configured: true as const,
    entitlementId,
    dbPremiumCount,
    sampled: candidates.length,
    rcActiveInSample: rcActiveCount,
    mismatchCount: mismatches.length,
    mismatches,
    generatedAt: new Date().toISOString(),
  };
}
