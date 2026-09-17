import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { deleteUsersByIds, signupUser } from './helpers';

const createdIds: string[] = [];

afterAll(async () => {
  await deleteUsersByIds(createdIds);
  await prisma.$disconnect();
});

describe('recurring rule APIs', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/recurring');
    expect(res.status).toBe(401);
  });

  it('creates, lists, runs, updates, and deletes a rule', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const created = await request(app)
      .post('/api/recurring')
      .set(account.auth)
      .send({
        description: 'Netflix',
        amount: 499,
        category: 'Entertainment',
        frequency: 'monthly',
        dayOfMonth: 15,
      });

    expect(created.status).toBe(201);
    const ruleId = created.body.data.rule.id as string;
    expect(created.body.data.rule.nextRunAt).toBeTruthy();

    const listed = await request(app).get('/api/recurring').set(account.auth);
    expect(listed.body.data.rules.some((r: { id: string }) => r.id === ruleId)).toBe(true);

    const ran = await request(app).post(`/api/recurring/${ruleId}/run`).set(account.auth);
    expect(ran.status).toBe(201);
    expect(ran.body.data.expense.description).toBe('Netflix');
    expect(ran.body.data.expense.amount).toBe(499);

    const expenses = await request(app).get('/api/expenses').set(account.auth);
    expect(expenses.body.data.expenses.some((e: { description: string }) => e.description === 'Netflix')).toBe(
      true
    );

    const paused = await request(app)
      .patch(`/api/recurring/${ruleId}`)
      .set(account.auth)
      .send({ isActive: false });
    expect(paused.status).toBe(200);
    expect(paused.body.data.rule.isActive).toBe(false);

    const deleted = await request(app).delete(`/api/recurring/${ruleId}`).set(account.auth);
    expect(deleted.status).toBe(200);
  });

  it("does not run another user's rule", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    createdIds.push(owner.user.id, stranger.user.id);

    const created = await request(app)
      .post('/api/recurring')
      .set(owner.auth)
      .send({ description: 'Spotify', amount: 199, category: 'Entertainment', frequency: 'monthly' });
    const ruleId = created.body.data.rule.id as string;

    const res = await request(app).post(`/api/recurring/${ruleId}/run`).set(stranger.auth);
    expect(res.status).toBe(404);
  });
});
