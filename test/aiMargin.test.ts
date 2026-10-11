import { afterAll, describe, expect, it, vi } from 'vitest';
import prisma from '../src/config/prisma';
import { deleteUsersByIds, setPremium, signupUser } from './helpers';

const topRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('../src/services/aiMetrics.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/aiMetrics.service')>()),
  getTopAiUsers: vi.fn(async () => ({
    period: 'month',
    month: new Date().toISOString().slice(0, 7),
    rows: topRows.rows,
  })),
}));

import { getAiMarginReport, marginFlag } from '../src/services/aiMargin.service';

const usage = (userId: string, costUsd: number) => ({
  userId,
  calls: 10,
  inputTokens: 1000,
  outputTokens: 100,
  tokens: 1100,
  costUsd,
  topKind: 'advisor_ask',
});

describe('marginFlag', () => {
  it('flags paying users whose AI cost exceeds their revenue', () => {
    expect(marginFlag({ costUsd: 3, revenueUsd: 2, isPremium: true }, true, 0.5)).toBe(
      'cost_exceeds_revenue'
    );
    expect(marginFlag({ costUsd: 1, revenueUsd: 2, isPremium: true }, true, 0.5)).toBeNull();
  });

  it('flags free users over the monthly threshold, but not on all-time totals', () => {
    expect(marginFlag({ costUsd: 0.6, revenueUsd: 0, isPremium: false }, true, 0.5)).toBe(
      'free_high_cost'
    );
    expect(marginFlag({ costUsd: 0.6, revenueUsd: 0, isPremium: false }, false, 0.5)).toBeNull();
    expect(marginFlag({ costUsd: 0.4, revenueUsd: 0, isPremium: false }, true, 0.5)).toBeNull();
  });
});

describe('getAiMarginReport', () => {
  const userIds: string[] = [];

  afterAll(async () => {
    await prisma.billingWebhookEvent.deleteMany({ where: { userId: { in: userIds } } });
    await deleteUsersByIds(userIds);
  });

  it('nets charges and refunds, ignoring sandbox, duplicates and non-charge events', async () => {
    const payer = await signupUser();
    const free = await signupUser();
    userIds.push(payer.user.id, free.user.id);
    await setPremium(payer.user.id, true);

    const ev = (eventType: string, priceUsd: number, extra: Record<string, unknown> = {}) => ({
      userId: payer.user.id,
      eventType,
      priceUsd,
      outcome: 'processed',
      environment: 'PRODUCTION',
      ...extra,
    });
    await prisma.billingWebhookEvent.createMany({
      data: [
        ev('INITIAL_PURCHASE', 4.99),
        ev('RENEWAL', 4.99),
        ev('CANCELLATION', -4.99), // refund
        ev('EXPIRATION', 4.99), // carries the price but isn't a charge
        ev('RENEWAL', 4.99, { outcome: 'duplicate' }),
        ev('RENEWAL', 4.99, { environment: 'SANDBOX' }),
      ],
    });

    topRows.rows = [usage(payer.user.id, 6), usage(free.user.id, 0.75)];
    const report = await getAiMarginReport('month', 'margin', 20);

    const payerRow = report.rows.find((r) => r.userId === payer.user.id)!;
    expect(payerRow.revenueUsd).toBeCloseTo(4.99);
    expect(payerRow.flag).toBe('cost_exceeds_revenue');

    const freeRow = report.rows.find((r) => r.userId === free.user.id)!;
    expect(freeRow.revenueUsd).toBe(0);
    expect(freeRow.flag).toBe('free_high_cost');

    expect(report.summary.flagged).toBe(2);
    // Margin sort puts the biggest loss first.
    expect(report.rows[0].userId).toBe(payer.user.id);
  });
});
