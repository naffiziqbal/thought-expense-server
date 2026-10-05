import { Response, NextFunction } from 'express';
import { asyncHandler, AppError } from '../middleware/error.middleware';
import { AdminAuthRequest } from '../middleware/adminAuth.middleware';
import { clientIp, logAdminAction } from '../services/adminAudit.service';
import {
  findBillingDriftUsers,
  getGrowthSeries,
  getOverviewStats,
  getUserDetail,
  listAdminAuditLogs,
  listBillingWebhookEvents,
  listUsers,
  reconcileStalePremiumFlags,
  revokeUserSessions,
  updateUserAdmin,
} from '../services/admin.service';
import { applyUserModeration, type ModerationAction } from '../services/userModeration.service';
import { getAiUsageSeries, getUserAiUsageSummary } from '../services/aiMetrics.service';
import {
  getQueueMonitorStats,
  getRagHealthStats,
  getRedisHealth,
  getRevenueCatSyncCheck,
} from '../services/adminOps.service';

export const getStatsOverview = asyncHandler(async (_req: AdminAuthRequest, res: Response) => {
  const data = await getOverviewStats();
  res.json({ success: true, data });
});

export const getGrowth = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || '30'), 10) || 30));
  const data = await getGrowthSeries(days);
  res.json({ success: true, data });
});

export const getUsers = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '20'), 10) || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const accessRaw = typeof req.query.access === 'string' ? req.query.access : 'all';
  const access =
    accessRaw === 'free' ||
    accessRaw === 'premium' ||
    accessRaw === 'manual' ||
    accessRaw === 'store' ||
    accessRaw === 'paying'
      ? accessRaw
      : 'all';
  const data = await listUsers({ page, limit, search: search || undefined, access });
  res.json({ success: true, data });
});

export const getUser = asyncHandler(
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    const user = await getUserDetail(req.params.id);
    if (!user) return next(new AppError('User not found', 404));
    res.json({ success: true, data: user });
  }
);

export const patchUser = asyncHandler(
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    const { isPremium, subscriptionStatus, premiumUntil } = req.body ?? {};
    const data: {
      isPremium?: boolean;
      subscriptionStatus?: string | null;
      premiumUntil?: Date | null;
    } = {};
    if (typeof isPremium === 'boolean') data.isPremium = isPremium;
    if (subscriptionStatus !== undefined) {
      data.subscriptionStatus =
        subscriptionStatus === null || subscriptionStatus === ''
          ? null
          : String(subscriptionStatus);
    }
    if (premiumUntil !== undefined) {
      if (premiumUntil === null || premiumUntil === '') {
        data.premiumUntil = null;
      } else {
        const until = new Date(String(premiumUntil));
        if (Number.isNaN(until.getTime())) {
          return next(new AppError('Invalid premiumUntil date', 400));
        }
        if (data.isPremium !== false && until.getTime() <= Date.now()) {
          return next(
            new AppError('premiumUntil must be in the future when granting premium', 400)
          );
        }
        data.premiumUntil = until;
      }
    }
    if (data.isPremium === true && data.premiumUntil === undefined) {
      return next(
        new AppError('premiumUntil is required when granting premium (or set lifetime: true)', 400)
      );
    }
    if (Object.keys(data).length === 0) {
      return next(new AppError('No valid fields to update', 400));
    }
    try {
      const user = await updateUserAdmin(req.params.id, data);
      if (!user) return next(new AppError('User not found', 404));
      if (req.admin) {
        await logAdminAction({
          adminId: req.admin.id,
          action: 'user.update',
          targetType: 'user',
          targetId: user.id,
          metadata: data,
          ipAddress: clientIp(req),
        });
      }
      res.json({ success: true, data: user });
    } catch {
      return next(new AppError('User not found', 404));
    }
  }
);

export const postUserModeration = asyncHandler(
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    const actionRaw = req.body?.action;
    const action =
      actionRaw === 'suspend' || actionRaw === 'ban' || actionRaw === 'reactivate'
        ? (actionRaw as ModerationAction)
        : null;
    if (!action) {
      return next(new AppError('action must be suspend, ban, or reactivate', 400));
    }
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    try {
      const user = await applyUserModeration(req.params.id, action, note);
      if (!user) return next(new AppError('User not found', 404));
      if (req.admin) {
        await logAdminAction({
          adminId: req.admin.id,
          action: `user.${action}`,
          targetType: 'user',
          targetId: user.id,
          metadata: { note: note?.trim() || null },
          ipAddress: clientIp(req),
        });
      }
      res.json({ success: true, data: user });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'USER_BANNED') {
        return next(new AppError('User is banned; reactivate before suspending', 409));
      }
      if (code === 'ALREADY_SUSPENDED' || code === 'ALREADY_BANNED' || code === 'ALREADY_ACTIVE') {
        return next(new AppError('No change — account is already in that state', 409));
      }
      return next(new AppError('User not found', 404));
    }
  }
);

export const postRevokeUserSessions = asyncHandler(
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await revokeUserSessions(req.params.id);
      if (req.admin) {
        await logAdminAction({
          adminId: req.admin.id,
          action: 'user.revoke_sessions',
          targetType: 'user',
          targetId: user.id,
          metadata: { tokenVersion: user.tokenVersion },
          ipAddress: clientIp(req),
        });
      }
      res.json({ success: true, data: user });
    } catch {
      return next(new AppError('User not found', 404));
    }
  }
);

export const getBillingEvents = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '30'), 10) || 30));
  const data = await listBillingWebhookEvents({ page, limit });
  res.json({ success: true, data });
});

export const getBillingDrift = asyncHandler(async (_req: AdminAuthRequest, res: Response) => {
  const items = await findBillingDriftUsers();
  res.json({ success: true, data: { items, count: items.length } });
});

export const getAuditLogs = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '30'), 10) || 30));
  const data = await listAdminAuditLogs({ page, limit });
  res.json({ success: true, data });
});

export const getSystemHealth = asyncHandler(async (_req: AdminAuthRequest, res: Response) => {
  const redis = await getRedisHealth();
  res.json({
    success: true,
    data: {
      status: redis.ok ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      nodeEnv: process.env.NODE_ENV || 'development',
      redis,
    },
  });
});

export const getAiUsage = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || '30'), 10) || 30));
  const data = await getAiUsageSeries(days);
  res.json({ success: true, data });
});

export const getUserAiUsage = asyncHandler(
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    const user = await getUserDetail(req.params.id);
    if (!user) return next(new AppError('User not found', 404));
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || '30'), 10) || 30));
    const data = await getUserAiUsageSummary(req.params.id, days);
    res.json({
      success: true,
      data: {
        ...data,
        days,
        note: 'Counts from deploy forward; tokens from Gemini usageMetadata when available.',
      },
    });
  }
);

export const getQueueMonitor = asyncHandler(async (_req: AdminAuthRequest, res: Response) => {
  const data = await getQueueMonitorStats();
  res.json({ success: true, data });
});

export const getRagHealth = asyncHandler(async (_req: AdminAuthRequest, res: Response) => {
  const data = await getRagHealthStats();
  res.json({ success: true, data });
});

export const getRevenueCatSync = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  const limit = Math.min(200, Math.max(5, parseInt(String(req.query.limit || '200'), 10) || 200));
  const data = await getRevenueCatSyncCheck(limit);
  res.json({ success: true, data });
});

export const postReconcileStalePremium = asyncHandler(
  async (req: AdminAuthRequest, res: Response) => {
    const result = await reconcileStalePremiumFlags();
    if (req.admin) {
      await logAdminAction({
        adminId: req.admin.id,
        action: 'billing.reconcile_stale_premium',
        targetType: 'system',
        targetId: null,
        metadata: result,
        ipAddress: clientIp(req),
      });
    }
    res.json({ success: true, data: result });
  }
);
