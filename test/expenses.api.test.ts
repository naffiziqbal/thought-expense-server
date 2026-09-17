import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { createExpense, deleteUsersByIds, setPremium, signupUser } from './helpers';

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

  it('rejects invalid create payloads', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const res = await request(app)
      .post('/api/expenses')
      .set(account.auth)
      .send({ description: '', amount: -5 });

    expect(res.status).toBe(400);
  });

  it('creates, lists, reads, updates, and deletes an expense', async () => {
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

    const byId = await request(app).get(`/api/expenses/${expenseId}`).set(account.auth);
    expect(byId.status).toBe(200);
    expect(byId.body.data.expense.id).toBe(expenseId);

    const updated = await request(app)
      .patch(`/api/expenses/${expenseId}`)
      .set(account.auth)
      .send({ description: 'Espresso', amount: 150, category: 'Food' });

    expect(updated.status).toBe(200);
    expect(updated.body.data.expense.description).toBe('Espresso');
    expect(updated.body.data.expense.amount).toBe(150);

    const deleted = await request(app).delete(`/api/expenses/${expenseId}`).set(account.auth);
    expect(deleted.status).toBe(200);

    const missing = await request(app).get(`/api/expenses/${expenseId}`).set(account.auth);
    expect(missing.status).toBe(404);
  });

  it('creates a batch of expenses', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const res = await request(app)
      .post('/api/expenses/batch')
      .set(account.auth)
      .send({
        expenses: [
          { description: 'Lunch', amount: 400, category: 'Food' },
          { description: 'Bus', amount: 50, category: 'Transport' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.expenses).toHaveLength(2);
  });

  it('returns a category summary', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    await createExpense(account.auth, {
      description: 'Dinner',
      amount: 800,
      category: 'Food',
      date: '2026-09-10',
    });
    await createExpense(account.auth, {
      description: 'Cab',
      amount: 200,
      category: 'Transport',
      date: '2026-09-10',
    });

    const res = await request(app).get('/api/expenses/summary').set(account.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.transactionCount).toBe(2);
    expect(res.body.data.totalSpent).toBe(1000);
    expect(res.body.data.byCategory.Food).toBe(800);
    expect(res.body.data.byCategory.Transport).toBe(200);
  });

  it('does not reassign an expense when PATCH includes another userId', async () => {
    const owner = await signupUser({ name: 'Owner' });
    const other = await signupUser({ name: 'Other' });
    createdIds.push(owner.user.id, other.user.id);

    const expense = await createExpense(owner.auth, {
      description: 'Uber',
      amount: 250,
      category: 'Transport',
    });

    const patched = await request(app)
      .patch(`/api/expenses/${expense.id}`)
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

    const asOther = await request(app).get(`/api/expenses/${expense.id}`).set(other.auth);
    expect(asOther.status).toBe(404);

    const row = await prisma.expense.findUnique({ where: { id: expense.id } });
    expect(row?.userId).toBe(owner.user.id);
  });

  it("does not leak another user's expense", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    createdIds.push(owner.user.id, stranger.user.id);

    const expense = await createExpense(owner.auth, {
      description: 'Rent',
      amount: 20000,
      category: 'Rent',
    });

    const res = await request(app).get(`/api/expenses/${expense.id}`).set(stranger.auth);
    expect(res.status).toBe(404);

    const del = await request(app).delete(`/api/expenses/${expense.id}`).set(stranger.auth);
    expect(del.status).toBe(404);
  });

  it('blocks CSV export for free users and allows it for premium', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    await createExpense(account.auth, { description: 'Snack', amount: 40, category: 'Food' });

    const blocked = await request(app).get('/api/expenses/export?format=csv').set(account.auth);
    expect(blocked.status).toBe(403);

    await setPremium(account.user.id, true);
    const allowed = await request(app).get('/api/expenses/export?format=csv').set(account.auth);
    expect(allowed.status).toBe(200);
    expect(allowed.headers['content-type']).toMatch(/csv/);
    expect(String(allowed.text)).toMatch(/Snack/);
  });

  it('blocks receipt OCR for free users', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).post('/api/expenses/ocr').set(account.auth);
    expect(res.status).toBe(403);
  });

  it('validates parse input without calling the model', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const empty = await request(app).post('/api/expenses/parse').set(account.auth).send({});
    expect(empty.status).toBe(400);

    const tooLong = await request(app)
      .post('/api/expenses/parse')
      .set(account.auth)
      .send({ rawInput: 'x'.repeat(5001) });
    expect(tooLong.status).toBe(400);
  });

  it('returns similar expenses as an empty list when Pinecone is down', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const expense = await createExpense(account.auth, {
      description: 'Coffee shop',
      amount: 90,
      category: 'Food',
    });

    const res = await request(app).get(`/api/expenses/${expense.id}/similar`).set(account.auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.similar)).toBe(true);
  });

  it('returns detected recurring expenses', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).get('/api/expenses/recurring').set(account.auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.recurring)).toBe(true);
  });
});
