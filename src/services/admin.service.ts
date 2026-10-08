import prisma from '../config/prisma';
import { logger } from '../config/logger';
import {
  buildSubscriptionSummary,
  manualPremiumLifetimeUntil,
  refreshStalePremium,
} from '../utils/subscription.util';
import { getRevenueCatSubscriberForUser } from './adminOps.service';
import { sendManualPremiumGrantedEmail } from './email.service';
import { moderationStatus } from '../utils/userModeration.util';

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function getOverviewStats() {
  const now = new Date();
  const day7 = daysAgo(7);
  const day30 = daysAgo(30);

  const [
    totalUsers,
    premiumUsers,
    premiumWithStoreProduct,
    premiumManualComp,
    premiumStalePeriod,
    premiumExpiredStatus,
    premiumNoUntil,
    premiumHeuristicActive,
    signups7d,
    signups30d,
    totalExpenses,
    expenses7d,
    subscriptionBreakdown,
    platformBreakdown,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isPremium: true } }),
    prisma.user.count({
      where: { isPremium: true, subscriptionProductId: { not: null } },
    }),
    prisma.user.count({
      where: { isPremium: true, subscriptionProductId: null },
    }),
    prisma.user.count({ where: { isPremium: true, premiumUntil: { lt: now } } }),
    prisma.user.count({ where: { isPremium: true, subscriptionStatus: 'expired' } }),
    prisma.user.count({ where: { isPremium: true, premiumUntil: null } }),
    prisma.user.count({
      where: {
        isPremium: true,
        subscriptionProductId: { not: null },
        subscriptionStatus: { in: ['active', 'cancelled', 'grace'] },
        OR: [{ premiumUntil: null }, { premiumUntil: { gt: now } }],
      },
    }),
    prisma.user.count({ where: { createdAt: { gte: day7 } } }),
    prisma.user.count({ where: { createdAt: { gte: day30 } } }),
    prisma.expense.count(),
    prisma.expense.count({ where: { createdAt: { gte: day7 } } }),
    prisma.user.groupBy({
      by: ['subscriptionStatus'],
      _count: { _all: true },
      where: { isPremium: true },
    }),
    prisma.deviceToken.groupBy({
      by: ['platform'],
      _count: { _all: true },
    }),
  ]);

  const activeDevices = await prisma.deviceToken.count();

  return {
    totalUsers,
    premiumUsers,
    freeUsers: totalUsers - premiumUsers,
    premiumRate: totalUsers > 0 ? Math.round((premiumUsers / totalUsers) * 1000) / 10 : 0,
    premiumBreakdown: {
      /** Same as premiumUsers — who the app treats as premium today */
      dbFlag: premiumUsers,
      /** Comp / fee / admin grant — no Play or App Store product id on file */
      manualComp: premiumManualComp,
      /** Premium with a store product id (RevenueCat webhook path) */
      storeBacked: premiumWithStoreProduct,
      /** Active paying: store product + valid period + status active/cancelled/grace */
      payingActive: premiumHeuristicActive,
      /** @deprecated use payingActive */
      heuristicBillable: premiumHeuristicActive,
      withStoreProduct: premiumWithStoreProduct,
      stalePeriodEnd: premiumStalePeriod,
      statusExpired: premiumExpiredStatus,
      noPremiumUntil: premiumNoUntil,
    },
    signups7d,
    signups30d,
    totalExpenses,
    expenses7d,
    activeDevices,
    subscriptionBreakdown: subscriptionBreakdown.map((r) => ({
      status: r.subscriptionStatus ?? 'unknown',
      count: r._count._all,
    })),
    platformBreakdown: platformBreakdown.map((r) => ({
      platform: r.platform,
      count: r._count._all,
    })),
    generatedAt: now.toISOString(),
  };
}

export async function getGrowthSeries(days = 30) {
  const since = daysAgo(days);
  const users = await prisma.user.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, isPremium: true },
    orderBy: { createdAt: 'asc' },
  });

  const byDay: Record<string, { signups: number; premiumSignups: number }> = {};
  for (let i = 0; i < days; i++) {
    const d = daysAgo(days - 1 - i);
    const key = d.toISOString().slice(0, 10);
    byDay[key] = { signups: 0, premiumSignups: 0 };
  }

  for (const u of users) {
    const key = u.createdAt.toISOString().slice(0, 10);
    if (!byDay[key]) byDay[key] = { signups: 0, premiumSignups: 0 };
    byDay[key].signups += 1;
    if (u.isPremium) byDay[key].premiumSignups += 1;
  }

  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));
}

export type UserAccessFilter = 'all' | 'free' | 'premium' | 'manual' | 'store' | 'paying';

function accessFilterWhere(access: UserAccessFilter | undefined) {
  const now = new Date();
  switch (access) {
    case 'free':
      return { isPremium: false };
    case 'premium':
      return { isPremium: true };
    case 'manual':
      return { isPremium: true, subscriptionProductId: null };
    case 'store':
      return { isPremium: true, subscriptionProductId: { not: null } };
    case 'paying':
      return {
        isPremium: true,
        subscriptionProductId: { not: null },
        subscriptionStatus: { in: ['active', 'cancelled', 'grace'] },
        OR: [{ premiumUntil: null }, { premiumUntil: { gt: now } }],
      };
    default:
      return {};
  }
}

export async function listUsers(params: {
  page: number;
  limit: number;
  search?: string;
  access?: UserAccessFilter;
}) {
  const { page, limit, search, access } = params;
  const skip = (page - 1) * limit;
  const searchWhere = search
    ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { name: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};
  const accessWhere = accessFilterWhere(access);
  const where =
    Object.keys(searchWhere).length && Object.keys(accessWhere).length
      ? { AND: [searchWhere, accessWhere] }
      : { ...searchWhere, ...accessWhere };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        currency: true,
        isPremium: true,
        subscriptionStatus: true,
        subscriptionProductId: true,
        subscriptionStore: true,
        premiumSince: true,
        premiumUntil: true,
        suspendedAt: true,
        bannedAt: true,
        createdAt: true,
        _count: { select: { expenses: true, deviceTokens: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  const items = rows.map((u) => ({
    ...u,
    accountStatus: moderationStatus(u),
    premiumAccess: premiumSource({
      isPremium: u.isPremium,
      subscriptionProductId: u.subscriptionProductId,
    }),
  }));

  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

const adminUserDetailSelect = {
  id: true,
  email: true,
  name: true,
  currency: true,
  isPremium: true,
  premiumSince: true,
  premiumUntil: true,
  subscriptionStatus: true,
  subscriptionProductId: true,
  subscriptionStore: true,
  pushEnabled: true,
  budgetAlertsEnabled: true,
  tokenVersion: true,
  suspendedAt: true,
  bannedAt: true,
  moderationNote: true,
  lastActiveAt: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      expenses: true,
      insights: true,
      goals: true,
      budgets: true,
      deviceTokens: true,
      recurringRules: true,
    },
  },
} as const;

/** Null when subscription fields look consistent; otherwise a short support note. */
export function subscriptionDriftNote(user: {
  isPremium: boolean;
  subscriptionStatus: string | null;
  premiumUntil: Date | null;
  subscriptionProductId: string | null;
}): string | null {
  const now = Date.now();
  if (user.isPremium && user.premiumUntil && user.premiumUntil.getTime() < now) {
    return 'Premium flag is still true but premiumUntil is in the past (run Billing → Reconcile stale).';
  }
  if (user.isPremium && user.subscriptionStatus === 'expired') {
    return 'Premium flag is true but subscriptionStatus is expired.';
  }
  if (!user.isPremium && ['active', 'grace'].includes(user.subscriptionStatus ?? '')) {
    if (user.premiumUntil && user.premiumUntil.getTime() > now) {
      return 'User is not premium but status is active/grace with a future premiumUntil.';
    }
  }
  if (!user.isPremium && user.subscriptionStatus === 'active' && user.subscriptionProductId) {
    return 'Store product on file and status active, but isPremium is false.';
  }
  return null;
}

export function premiumSource(user: {
  isPremium: boolean;
  subscriptionProductId: string | null;
}): 'none' | 'store' | 'manual' {
  if (!user.isPremium) return 'none';
  return user.subscriptionProductId ? 'store' : 'manual';
}

/** Same billing refresh as GET /api/billing/status so admin matches in-app access. */
export async function getUserDetail(userId: string) {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: adminUserDetailSelect,
  });
  if (!row) return null;

  const billing = await refreshStalePremium(userId, row);
  const subscription = buildSubscriptionSummary(billing);
  const access = premiumSource({
    isPremium: billing.isPremium,
    subscriptionProductId: billing.subscriptionProductId,
  });
  const drift = subscriptionDriftNote({
    isPremium: billing.isPremium,
    subscriptionStatus: billing.subscriptionStatus,
    premiumUntil: billing.premiumUntil,
    subscriptionProductId: billing.subscriptionProductId,
  });

  const [billingEvents, lastExpense, revenueCat] = await Promise.all([
    prisma.billingWebhookEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        externalEventId: true,
        eventType: true,
        productId: true,
        store: true,
        outcome: true,
        createdAt: true,
      },
    }),
    prisma.expense.findFirst({
      where: { userId },
      orderBy: { date: 'desc' },
      select: { date: true },
    }),
    getRevenueCatSubscriberForUser(userId, billing.isPremium),
  ]);

  return {
    ...row,
    accountStatus: moderationStatus(row),
    isPremium: billing.isPremium,
    premiumSince: billing.premiumSince,
    premiumUntil: billing.premiumUntil,
    subscriptionStatus: billing.subscriptionStatus,
    subscriptionProductId: billing.subscriptionProductId,
    subscriptionStore: billing.subscriptionStore,
    subscription,
    premiumAccess: access,
    subscriptionDrift: drift,
    lastExpenseAt: lastExpense?.date ?? null,
    billingEvents,
    revenueCat,
  };
}

export async function updateUserAdmin(
  userId: string,
  data: {
    isPremium?: boolean;
    subscriptionStatus?: string | null;
    premiumUntil?: Date | null;
  }
): Promise<{ user: Awaited<ReturnType<typeof getUserDetail>>; premiumEmailSent: boolean }> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      isPremium: true,
      premiumSince: true,
      premiumUntil: true,
      subscriptionStatus: true,
      subscriptionProductId: true,
      subscriptionStore: true,
    },
  });
  if (!existing) {
    throw new Error('User not found');
  }

  const patch: {
    isPremium?: boolean;
    subscriptionStatus?: string | null;
    subscriptionProductId?: string | null;
    subscriptionStore?: string | null;
    premiumSince?: Date;
    premiumUntil?: Date | null;
  } = {};

  if (typeof data.isPremium === 'boolean') patch.isPremium = data.isPremium;
  if (data.subscriptionStatus !== undefined) patch.subscriptionStatus = data.subscriptionStatus;
  if (data.premiumUntil !== undefined) {
    patch.premiumUntil =
      data.premiumUntil === null && data.isPremium === true
        ? manualPremiumLifetimeUntil()
        : data.premiumUntil;
  }

  const resolvedPremiumUntil = (): Date | null | undefined => {
    if (data.premiumUntil === undefined) return existing.premiumUntil;
    if (data.premiumUntil === null && data.isPremium === true) return manualPremiumLifetimeUntil();
    return data.premiumUntil;
  };

  if (data.isPremium === true) {
    if (!existing.premiumSince) patch.premiumSince = new Date();
    // Admin comp: clear store ids so billing segments stay "manual"
    patch.subscriptionProductId = null;
    patch.subscriptionStore = null;
    patch.subscriptionStatus = 'active';
  } else if (data.isPremium === false) {
    patch.subscriptionStatus = 'expired';
  }

  await prisma.user.update({
    where: { id: userId },
    data: patch,
  });

  const finalPremiumUntil = resolvedPremiumUntil();
  const willBePremium = data.isPremium === true || (data.isPremium !== false && existing.isPremium);
  const isNewGrant = data.isPremium === true && !existing.isPremium;
  const expiryChanged =
    data.premiumUntil !== undefined &&
    (existing.premiumUntil?.getTime() ?? null) !== (finalPremiumUntil?.getTime() ?? null);
  const shouldEmail = willBePremium && (isNewGrant || expiryChanged) && data.isPremium !== false;

  let premiumEmailSent = false;
  if (shouldEmail) {
    const result = await sendManualPremiumGrantedEmail(existing.email, {
      name: existing.name,
      premiumUntil: finalPremiumUntil ?? null,
      isNewGrant,
    });
    premiumEmailSent = result.success;
    if (!result.success) {
      logger.warn(
        { userId, email: existing.email, error: result.error },
        'Manual premium granted but notification email failed'
      );
    }
  }

  const user = await getUserDetail(userId);
  return { user, premiumEmailSent };
}

export async function revokeUserSessions(userId: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
    select: { id: true, email: true, tokenVersion: true },
  });
}

export async function listBillingWebhookEvents(params: { page: number; limit: number }) {
  const { page, limit } = params;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.billingWebhookEvent.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.billingWebhookEvent.count(),
  ]);
  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

function driftReason(user: {
  isPremium: boolean;
  subscriptionStatus: string | null;
  premiumUntil: Date | null;
  subscriptionProductId: string | null;
}): string {
  const now = Date.now();
  if (user.isPremium && user.premiumUntil && user.premiumUntil.getTime() < now) {
    return 'Premium flag set but period ended';
  }
  if (user.isPremium && user.subscriptionStatus === 'expired') {
    return 'Premium flag set but status is expired';
  }
  if (!user.isPremium && ['active', 'grace'].includes(user.subscriptionStatus ?? '')) {
    if (user.premiumUntil && user.premiumUntil.getTime() > now) {
      return 'Status active/grace but premium flag is false';
    }
  }
  if (!user.isPremium && user.subscriptionStatus === 'active' && user.subscriptionProductId) {
    return 'Active product on file but premium flag is false';
  }
  return 'Inconsistent subscription fields';
}

/** Clear isPremium when period ended or status is expired (missed EXPIRATION webhooks). */
export async function reconcileStalePremiumFlags() {
  const now = new Date();
  const result = await prisma.user.updateMany({
    where: {
      OR: [
        { isPremium: true, premiumUntil: { lt: now } },
        { isPremium: true, subscriptionStatus: 'expired' },
      ],
    },
    data: { isPremium: false },
  });
  return { updated: result.count };
}

export async function findBillingDriftUsers() {
  const now = new Date();
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { isPremium: true, premiumUntil: { lt: now } },
        { isPremium: true, subscriptionStatus: 'expired' },
        {
          isPremium: false,
          subscriptionStatus: { in: ['active', 'grace'] },
          premiumUntil: { gt: now },
        },
        {
          isPremium: false,
          subscriptionStatus: 'active',
          subscriptionProductId: { not: null },
        },
      ],
    },
    select: {
      id: true,
      email: true,
      name: true,
      isPremium: true,
      subscriptionStatus: true,
      premiumUntil: true,
      subscriptionProductId: true,
      updatedAt: true,
    },
    take: 100,
    orderBy: { updatedAt: 'desc' },
  });
  return users.map((u) => ({ ...u, reason: driftReason(u) }));
}

export async function listAdminAuditLogs(params: { page: number; limit: number }) {
  const { page, limit } = params;
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        admin: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.adminAuditLog.count(),
  ]);

  const userIds = [
    ...new Set(
      rows.filter((r) => r.targetType === 'user' && r.targetId).map((r) => r.targetId as string)
    ),
  ];
  const targetUsers =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true },
        })
      : [];
  const userById = new Map(targetUsers.map((u) => [u.id, u]));

  const items = rows.map((row) => ({
    ...row,
    targetUser:
      row.targetType === 'user' && row.targetId ? (userById.get(row.targetId) ?? null) : null,
  }));

  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}
