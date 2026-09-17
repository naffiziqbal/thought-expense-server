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

describe('expense APIs', () => {
  it('rejects unauthenticated access', async () => {
    const res = await request(app).get('/api/expenses');
    expect(res.status).toBe(401);
  });

  it('creates, lists, and updates an expense', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const created = await request(app)
      .post('/api/expenses')
      .set(account.auth)
      .send({
        description: 'Coffee',
        amount: 120,
        category: 'Food',
        date: '2026-09-17',
      });

    expect(created.status).toBe(201);
    const expenseId = created.body.data.expense.id as string;
    expect(created.body.data.expense.description).toBe('Coffee');
    expect(created.body.data.expense.amount).toBe(120);
    expect(created.body.data.expense.userId).toBe(account.user.id);

    const listed = await request(app).get('/api/expenses').set(account.auth);
    expect(listed.status).toBe(200);
    expect(listed.body.data.expenses.some((e: { id: string }) => e.id === expenseId)).toBe(true);

    const updated = await request(app)
      .patch(`/api/expenses/${expenseId}`)
      .set(account.auth)
      .send({ description: 'Espresso', amount: 150, category: 'Food' });

    expect(updated.status).toBe(200);
    expect(updated.body.data.expense.description).toBe('Espresso');
    expect(updated.body.data.expense.amount).toBe(150);
  });

  it('does not reassign an expense when PATCH includes another userId', async () => {
    const owner = await signupUser({ name: 'Owner' });
    const other = await signupUser({ name: 'Other' });
    createdIds.push(owner.user.id, other.user.id);

    const created = await request(app)
      .post('/api/expenses')
      .set(owner.auth)
      .send({ description: 'Uber', amount: 250, category: 'Transport' });

    const expenseId = created.body.data.expense.id as string;

    const patched = await request(app)
      .patch(`/api/expenses/${expenseId}`)
      .set(owner.auth)
      .send({
        description: 'Uber',
        amount: 250,
        userId: other.user.id,
        confidence: 0.1,
      });

    expect(patched.status).toBe(200);
    expect(patched.body.data.expense.userId).toBe(owner.user.id);
    expect(patched.body.data.expense.confidence).toBe(1);

    const asOther = await request(app)
      .get(`/api/expenses/${expenseId}`)
      .set(other.auth);
    expect(asOther.status).toBe(404);

    const row = await prisma.expense.findUnique({ where: { id: expenseId } });
    expect(row?.userId).toBe(owner.user.id);
  });

  it('does not leak another user\'s expense', async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    createdIds.push(owner.user.id, stranger.user.id);

    const created = await request(app)
      .post('/api/expenses')
      .set(owner.auth)
      .send({ description: 'Rent', amount: 20000, category: 'Rent' });

    const expenseId = created.body.data.expense.id as string;

    const res = await request(app)
      .get(`/api/expenses/${expenseId}`)
      .set(stranger.auth);

    expect(res.status).toBe(404);
  });
});
