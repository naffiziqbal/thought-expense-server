import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { createExpense, deleteUsersByIds, signupUser } from './helpers';

const createdIds: string[] = [];

afterAll(async () => {
  await deleteUsersByIds(createdIds);
  await prisma.$disconnect();
});

describe('insight APIs', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/insights');
    expect(res.status).toBe(401);
  });

  it('lists empty insights and latest briefing', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const listed = await request(app).get('/api/insights').set(account.auth);
    expect(listed.status).toBe(200);
    expect(listed.body.data.insights).toEqual([]);

    const briefing = await request(app).get('/api/insights/briefing/latest').set(account.auth);
    expect(briefing.status).toBe(200);
    expect(briefing.body.data.briefing).toBeNull();
  });

  it('skips AI generation when there are no expenses this week', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const res = await request(app).post('/api/insights/generate').set(account.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.insights).toEqual([]);
    expect(res.body.message).toMatch(/no expenses/i);
  });

  it('returns spending intelligence from stored expenses', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    await createExpense(account.auth, {
      description: 'Lunch',
      amount: 350,
      category: 'Food',
      date: new Date().toISOString(),
    });

    const res = await request(app).get('/api/insights/intelligence').set(account.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
  });
});
