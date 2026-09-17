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

describe('budget APIs', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/budgets/current');
    expect(res.status).toBe(401);
  });

  it('saves a monthly budget and reports spend against it', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const month = 9;
    const year = 2026;
    await createExpense(account.auth, {
      description: 'Groceries',
      amount: 3000,
      category: 'Food',
      date: '2026-09-08',
    });

    const saved = await request(app)
      .post('/api/budgets')
      .set(account.auth)
      .send({ month, year, total_limit: 10000 });
    expect(saved.status).toBe(200);

    const current = await request(app)
      .get(`/api/budgets/current?month=${month}&year=${year}`)
      .set(account.auth);
    expect(current.status).toBe(200);
    expect(current.body.data.total_limit).toBe(10000);
    expect(current.body.data.total_spent).toBe(3000);
    expect(current.body.data.remaining).toBe(7000);

    const history = await request(app).get('/api/budgets/history').set(account.auth);
    expect(history.status).toBe(200);
    expect(history.body.data.some((b: { month: number }) => b.month === month)).toBe(true);

    const deleted = await request(app)
      .delete(`/api/budgets/${current.body.data.id}`)
      .set(account.auth);
    expect(deleted.status).toBe(200);
  });

  it('saves and reads category budgets', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const saved = await request(app)
      .post('/api/budgets/categories')
      .set(account.auth)
      .send({
        month: 9,
        year: 2026,
        items: [
          { category: 'Food', limit: 5000 },
          { category: 'Transport', limit: 2000 },
        ],
      });
    expect(saved.status).toBe(200);

    const current = await request(app)
      .get('/api/budgets/categories/current?month=9&year=2026')
      .set(account.auth);
    expect(current.status).toBe(200);
    expect(current.body.data).toHaveLength(2);
  });

  it("does not delete another user's budget", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    createdIds.push(owner.user.id, stranger.user.id);

    await request(app)
      .post('/api/budgets')
      .set(owner.auth)
      .send({ month: 9, year: 2026, total_limit: 1000 });
    const current = await request(app)
      .get('/api/budgets/current?month=9&year=2026')
      .set(owner.auth);
    const budgetId = current.body.data.id as string;

    const res = await request(app).delete(`/api/budgets/${budgetId}`).set(stranger.auth);
    expect(res.status).toBe(404);
  });

  it('validates parse text', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app)
      .post('/api/budgets/categories/parse')
      .set(account.auth)
      .send({ text: 'ab' });
    expect(res.status).toBe(400);
  });
});
