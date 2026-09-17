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

describe('goals APIs', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/goals');
    expect(res.status).toBe(401);
  });

  it('creates, lists, contributes, completes, and deletes a goal', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const created = await request(app)
      .post('/api/goals')
      .set(account.auth)
      .send({ name: 'Emergency fund', targetAmount: 1000 });

    expect(created.status).toBe(201);
    const goalId = created.body.data.goal.id as string;
    expect(created.body.data.goal.progress).toBe(0);
    expect(created.body.data.goal.remaining).toBe(1000);

    const listed = await request(app).get('/api/goals').set(account.auth);
    expect(listed.body.data.goals.some((g: { id: string }) => g.id === goalId)).toBe(true);

    const contrib = await request(app)
      .post(`/api/goals/${goalId}/contribute`)
      .set(account.auth)
      .send({ amount: 400 });
    expect(contrib.status).toBe(200);
    expect(contrib.body.data.goal.savedAmount).toBe(400);
    expect(contrib.body.data.goal.progress).toBe(0.4);

    const done = await request(app)
      .post(`/api/goals/${goalId}/contribute`)
      .set(account.auth)
      .send({ amount: 600 });
    expect(done.status).toBe(200);
    expect(done.body.data.goal.status).toBe('completed');
    expect(done.body.data.goal.progress).toBe(1);

    const renamed = await request(app)
      .patch(`/api/goals/${goalId}`)
      .set(account.auth)
      .send({ name: 'Rainy day' });
    expect(renamed.body.data.goal.name).toBe('Rainy day');

    const deleted = await request(app).delete(`/api/goals/${goalId}`).set(account.auth);
    expect(deleted.status).toBe(200);
  });

  it("does not let another user contribute to a goal", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    createdIds.push(owner.user.id, stranger.user.id);

    const created = await request(app)
      .post('/api/goals')
      .set(owner.auth)
      .send({ name: 'Trip', targetAmount: 500 });
    const goalId = created.body.data.goal.id as string;

    const res = await request(app)
      .post(`/api/goals/${goalId}/contribute`)
      .set(stranger.auth)
      .send({ amount: 50 });
    expect(res.status).toBe(404);
  });
});
