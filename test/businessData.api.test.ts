import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { createExpense, deleteUsersByIds, signupUser } from './helpers';

const createdIds: string[] = [];
const eventIds: string[] = [];
const archivedUserIds: string[] = [];

afterAll(async () => {
  await prisma.billingWebhookEvent.deleteMany({ where: { externalEventId: { in: eventIds } } });
  await prisma.deletedAccount.deleteMany({ where: { userId: { in: archivedUserIds } } });
  await deleteUsersByIds(createdIds);
  await prisma.$disconnect();
});

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 3000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe('RevenueCat webhook revenue capture', () => {
  it('stores price, period and lifecycle fields without subscriber attributes', async () => {
    const auth = process.env.REVENUECAT_WEBHOOK_AUTH;
    if (!auth) return;

    const account = await signupUser();
    createdIds.push(account.user.id);
    const id = `rev-${account.user.id}`;
    eventIds.push(id);
    const purchasedAt = Date.now() - 1000;

    const res = await request(app)
      .post('/api/billing/revenuecat')
      .set('Authorization', auth)
      .send({
        event: {
          id,
          type: 'INITIAL_PURCHASE',
          app_user_id: account.user.id,
          product_id: 'premium_monthly',
          store: 'PLAY_STORE',
          price: 4.99,
          price_in_purchased_currency: 599,
          currency: 'BDT',
          period_type: 'NORMAL',
          purchased_at_ms: purchasedAt,
          expiration_at_ms: Date.now() + 86400000,
          environment: 'PRODUCTION',
          country_code: 'BD',
          transaction_id: 'GPA.1234',
          subscriber_attributes: { $email: { value: 'secret@example.com' } },
        },
      });
    expect(res.status).toBe(200);

    const row = await prisma.billingWebhookEvent.findFirst({ where: { externalEventId: id } });
    expect(row?.outcome).toBe('processed');
    expect(row?.priceUsd).toBe(4.99);
    expect(row?.priceLocal).toBe(599);
    expect(row?.currency).toBe('BDT');
    expect(row?.periodType).toBe('NORMAL');
    expect(row?.purchasedAt?.getTime()).toBe(purchasedAt);
    expect(row?.countryCode).toBe('BD');
    expect(JSON.stringify(row?.payload)).not.toContain('secret@example.com');
  });
});

describe('user activity', () => {
  it('records lastActiveAt on authenticated requests without bumping updatedAt', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });

    await request(app).get('/api/auth/me').set(account.auth);

    const after = await waitFor(async () => {
      const u = await prisma.user.findUnique({ where: { id: account.user.id } });
      return u?.lastActiveAt ? u : null;
    });
    expect(after?.lastActiveAt).toBeInstanceOf(Date);
    expect(after?.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

describe('deleted account archive', () => {
  it('keeps an anonymous record when a user deletes their account', async () => {
    const account = await signupUser({ currency: 'EUR' });
    archivedUserIds.push(account.user.id);
    await createExpense(account.auth, { description: 'coffee', amount: 3 });

    const res = await request(app)
      .delete('/api/auth/account')
      .set(account.auth)
      .send({ password: account.password });
    expect(res.status).toBe(200);

    const archived = await prisma.deletedAccount.findFirst({ where: { userId: account.user.id } });
    expect(archived).not.toBeNull();
    expect(archived?.expenseCount).toBe(1);
    expect(archived?.currency).toBe('EUR');
    expect(archived?.wasPremium).toBe(false);
    expect(Object.values(archived ?? {}).map(String)).not.toContain(account.email);
  });
});
