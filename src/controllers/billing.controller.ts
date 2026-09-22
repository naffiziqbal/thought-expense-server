import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { asyncHandler, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { logger } from '../config/logger';
import { setCacheNx, deleteCache } from '../config/redis';
import { buildSubscriptionSummary, refreshStalePremium, billingFieldsSelect } from '../utils/subscription.util';

/**
 * RevenueCat webhook -> keep User.isPremium/premiumUntil in sync with the
 * Google Play subscription lifecycle. Configure the same Authorization header
 * value in the RevenueCat dashboard and REVENUECAT_WEBHOOK_AUTH.
 * Docs: https://www.revenuecat.com/docs/integrations/webhooks
 */

const ACTIVE_EVENTS = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE']);

const STORE_MAP: Record<string, string> = {
  PLAY_STORE: 'play_store',
  APP_STORE: 'app_store',
  PROMOTIONAL: 'promo',
};

export const revenuecatWebhook = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const expectedAuth = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!expectedAuth) {
    return next(new AppError('Billing webhooks are not configured', 503));
  }
  if (req.headers.authorization !== expectedAuth) {
    return next(new AppError('Unauthorized', 401));
  }

  const event = req.body?.event;
  if (!event || !event.type) {
    return next(new AppError('Malformed webhook payload', 400));
  }

  // RevenueCat sends a TEST event when you press "send test" in the dashboard
  if (event.type === 'TEST') {
    res.json({ success: true, message: 'Test event received' });
    return;
  }

  const eventId = typeof event.id === 'string' ? event.id : null;
  if (eventId) {
    const lock = await setCacheNx(`idem:revenuecat:${eventId}`, { processed: true }, 60 * 60 * 24 * 14);
    if (lock === 'exists') {
      res.json({ success: true, message: 'Already processed' });
      return;
    }
  }

  try {
  // We log the app in with our own user id, so app_user_id is a User.id.
  const candidateIds = [event.app_user_id, event.original_app_user_id].filter(
    (id: unknown): id is string => typeof id === 'string' && !id.startsWith('$RCAnonymousID:')
  );

  let user = null;
  for (const id of candidateIds) {
    user = await prisma.user.findUnique({ where: { id } });
    if (user) break;
  }

  if (!user) {
    // 200 so RevenueCat does not retry forever for users we cannot map
    logger.warn({ candidateIds, eventType: event.type }, 'RevenueCat webhook: no matching user');
    res.json({ success: true, message: 'No matching user' });
    return;
  }

  const premiumUntil = event.expiration_at_ms ? new Date(event.expiration_at_ms) : null;
  const productId: string | null = event.product_id ?? null;
  const store = STORE_MAP[event.store as string] ?? (event.store ? String(event.store).toLowerCase() : null);
  const stillInPeriod = premiumUntil ? premiumUntil.getTime() > Date.now() : false;

  let data: Record<string, unknown> | null = null;

  if (ACTIVE_EVENTS.has(event.type)) {
    data = {
      isPremium: true,
      premiumSince: user.premiumSince ?? new Date(),
      premiumUntil,
      subscriptionStatus: 'active',
      subscriptionProductId: productId,
      subscriptionStore: store,
    };
  } else if (event.type === 'CANCELLATION') {
    // Auto-renew turned off (or refund). Access continues until period end unless refunded.
    const refunded = event.cancel_reason === 'CUSTOMER_SUPPORT' && !stillInPeriod;
    data = {
      isPremium: stillInPeriod && !refunded,
      premiumUntil,
      subscriptionStatus: stillInPeriod ? 'cancelled' : 'expired',
    };
  } else if (event.type === 'BILLING_ISSUE') {
    data = {
      isPremium: stillInPeriod,
      premiumUntil,
      subscriptionStatus: stillInPeriod ? 'grace' : 'expired',
    };
  } else if (event.type === 'EXPIRATION' || event.type === 'SUBSCRIPTION_PAUSED') {
    data = {
      isPremium: false,
      premiumUntil,
      subscriptionStatus: 'expired',
    };
  }

  if (data) {
    await prisma.user.update({ where: { id: user.id }, data });
  }

  res.json({ success: true });
  } catch (err) {
    if (eventId) await deleteCache(`idem:revenuecat:${eventId}`);
    throw err;
  }
});

// @desc    Current subscription status (also lazily expires stale premium)
// @route   GET /api/billing/status
// @access  Private
export const getBillingStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  const row = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: billingFieldsSelect,
  });

  if (!row) {
    res.json({ success: true, data: null });
    return;
  }

  const user = await refreshStalePremium(req.user!.id, row);
  const subscription = buildSubscriptionSummary(user);

  res.json({
    success: true,
    data: {
      isPremium: user.isPremium,
      premiumSince: user.premiumSince,
      premiumUntil: user.premiumUntil,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionProductId: user.subscriptionProductId,
      subscriptionStore: user.subscriptionStore,
      subscription,
    },
  });
});
