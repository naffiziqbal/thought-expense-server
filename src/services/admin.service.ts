import prisma from '../config/prisma';

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
      /** Closer to RevenueCat “active subscriptions”: store product + non-expired period + not expired status */
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

export async function listUsers(params: { page: number; limit: number; search?: string }) {
  const { page, limit, search } = params;
  const skip = (page - 1) * limit;
  const where = search
    ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { name: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [items, total] = await Promise.all([
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
        createdAt: true,
        _count: { select: { expenses: true, deviceTokens: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function getUserDetail(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
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
    },
  });
}

export async function updateUserAdmin(
  userId: string,
  data: { isPremium?: boolean; subscriptionStatus?: string | null }
) {
  return prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      email: true,
      isPremium: true,
      subscriptionStatus: true,
      premiumUntil: true,
    },
  });
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
  const [items, total] = await Promise.all([
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
  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}
