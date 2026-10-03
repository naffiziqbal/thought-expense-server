import prisma from '../config/prisma';

export async function recordBillingWebhookEvent(input: {
  externalEventId?: string | null;
  eventType: string;
  appUserId?: string | null;
  userId?: string | null;
  productId?: string | null;
  store?: string | null;
  outcome: string;
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
      },
    });
  } catch (err) {
    // Logging must not break webhook processing
    const { logger } = await import('../config/logger');
    logger.warn({ err, eventType: input.eventType }, 'Failed to persist billing webhook event');
  }
}
