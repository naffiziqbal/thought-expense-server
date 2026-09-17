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

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });
});

describe('unknown routes', () => {
  it('returns 404 json', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/auth/signup', () => {
  it('rejects invalid email and short password', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      email: 'not-an-email',
      password: '123',
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('creates a user and returns a token', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    expect(account.user.email).toBe(account.email.toLowerCase());
    expect(account.token.split('.')).toHaveLength(3);
  });

  it('rejects a duplicate email', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).post('/api/auth/signup').send({
      email: account.email,
      password: 'secret12',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already exists/i);
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token for valid credentials', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).post('/api/auth/login').send({
      email: account.email,
      password: account.password,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user.id).toBe(account.user.id);
  });

  it('rejects a wrong password', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).post('/api/auth/login').send({
      email: account.email,
      password: 'wrong-password',
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });
});

describe('GET /api/auth/me', () => {
  it('requires a bearer token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).get('/api/auth/me').set(account.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(account.user.id);
    expect(res.body.data.user.email).toBe(account.email.toLowerCase());
  });
});
