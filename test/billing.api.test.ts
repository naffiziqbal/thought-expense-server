import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { deleteUsersByIds, setPremium, signupUser } from './helpers';

const createdIds: string[] = [];

afterAll(async () => {
  await deleteUsersByIds(createdIds);
  await prisma.$disconnect();
});

describe('GET /api/billing/status', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/billing/status');
    expect(res.status).toBe(401);
  });

  it('returns free status and reflects a premium flag', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const free = await request(app).get('/api/billing/status').set(account.auth);
    expect(free.status).toBe(200);
    expect(free.body.data.isPremium).toBe(false);

    await setPremium(account.user.id, true);
    const paid = await request(app).get('/api/billing/status').set(account.auth);
    expect(paid.status).toBe(200);
    expect(paid.body.data.isPremium).toBe(true);
  });
});

describe('POST /api/billing/revenuecat', () => {
  it('rejects missing or wrong webhook auth', async () => {
    const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
    const noAuth = await request(app).post('/api/billing/revenuecat').send({ event: { type: 'TEST' } });
    if (!expected) {
      expect(noAuth.status).toBe(503);
      return;
    }

    expect(noAuth.status).toBe(401);

    const wrong = await request(app)
      .post('/api/billing/revenuecat')
      .set('Authorization', 'nope')
      .send({ event: { type: 'TEST' } });
    expect(wrong.status).toBe(401);

    const testEvent = await request(app)
      .post('/api/billing/revenuecat')
      .set('Authorization', expected)
      .send({ event: { type: 'TEST' } });
    expect(testEvent.status).toBe(200);
    expect(testEvent.body.message).toMatch(/test event/i);
  });

  it('grants premium on INITIAL_PURCHASE for a matching user', async () => {
    const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
    if (!expected) return;

    const account = await signupUser();
    createdIds.push(account.user.id);

    const res = await request(app)
      .post('/api/billing/revenuecat')
      .set('Authorization', expected)
      .send({
        event: {
          id: `test-${account.user.id}`,
          type: 'INITIAL_PURCHASE',
          app_user_id: account.user.id,
          expiration_at_ms: Date.now() + 86400000,
          product_id: 'premium_monthly',
          store: 'PLAY_STORE',
        },
      });

    expect(res.status).toBe(200);
    const user = await prisma.user.findUnique({ where: { id: account.user.id } });
    expect(user?.isPremium).toBe(true);
  });
});
