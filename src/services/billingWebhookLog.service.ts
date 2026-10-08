import { Prisma } from '@prisma/client';
import prisma from '../config/prisma';

export interface BillingRevenueFields {
  priceUsd?: number | null;
  priceLocal?: number | null;
  currency?: string | null;
  periodType?: string | null;
  purchasedAt?: Date | null;
  expiresAt?: Date | null;
  cancelReason?: string | null;
  environment?: string | null;
  countryCode?: string | null;
  transactionId?: string | null;
  payload?: Prisma.InputJsonValue | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const msDate = (v: unknown): Date | null => (typeof v === 'number' && v > 0 ? new Date(v) : null);

/**
 * Revenue/lifecycle fields from a RevenueCat webhook event.
 * subscriber_attributes is dropped from the stored payload (may contain email/phone).
 */
export function revenueFieldsFromEvent(event: Record<string, unknown>): BillingRevenueFields {
  const { subscriber_attributes: _attrs, ...rest } = event;
  return {
    priceUsd: num(event.price),
    priceLocal: num(event.price_in_purchased_currency),
    currency: str(event.currency),
    periodType: str(event.period_type),
    purchasedAt: msDate(event.purchased_at_ms),
    expiresAt: msDate(event.expiration_at_ms),
    cancelReason: str(event.cancel_reason) ?? str(event.expiration_reason),
    environment: str(event.environment),
    countryCode: str(event.country_code),
    transactionId: str(event.transaction_id),
    payload: rest as Prisma.InputJsonValue,
  };
}

export async function recordBillingWebhookEvent(input: {
  externalEventId?: string | null;
  eventType: string;
  appUserId?: string | null;
  userId?: string | null;
  productId?: string | null;
  store?: string | null;
  outcome: string;
  revenue?: BillingRevenueFields;
}) {
  try {
    await prisma.billingWebhookEvent.create({
      data: {
        externalEventId: input.externalEventId ?? null,
        eventType: input.eventType,
        appUserId: input.appUserId ?? null,
        userId: input.userId ?? null,
        productId: input.productId ?? null,
        store: input.store ?? null,
        outcome: input.outcome,
        ...input.revenue,
        payload: input.revenue?.payload ?? undefined,
      },
    });
  } catch (err) {
    // Logging must not break webhook processing
    const { logger } = await import('../config/logger');
    logger.warn({ err, eventType: input.eventType }, 'Failed to persist billing webhook event');
  }
}
