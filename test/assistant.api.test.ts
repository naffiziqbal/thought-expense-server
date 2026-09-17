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

describe('assistant APIs (validation only — no live Gemini calls)', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/api/assistant/ask').send({ question: 'hi' });
    expect(res.status).toBe(401);
  });

  it('rejects an empty question', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).post('/api/assistant/ask').set(account.auth).send({ question: '  ' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive savings target', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app)
      .post('/api/assistant/savings-plan')
      .set(account.auth)
      .send({ targetAmount: 0 });
    expect(res.status).toBe(400);
  });

  it('rejects a missing search query', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).get('/api/assistant/search').set(account.auth);
    expect(res.status).toBe(400);
  });
});
