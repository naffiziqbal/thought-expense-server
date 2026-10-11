import jwt from 'jsonwebtoken';
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

describe('PATCH /api/auth/profile', () => {
  it('updates name and currency', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const res = await request(app)
      .patch('/api/auth/profile')
      .set(account.auth)
      .send({ name: 'Nafiz', currency: 'bdt' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('Nafiz');
    expect(res.body.data.user.currency).toBe('BDT');
  });
});

describe('password reset endpoints', () => {
  it('does not reveal whether an email exists', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: testUnknownEmail() });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/if an account exists/i);
  });

  // This file runs without Redis. Without its guess counters, code checks must
  // refuse rather than run unlimited. (Wrong-code handling: passwordReset.api.test.ts.)
  it('refuses code checks when the guess counter is unavailable', async () => {
    const res = await request(app).post('/api/auth/verify-otp').send({
      email: testUnknownEmail(),
      otp: '000000',
    });
    expect(res.status).toBe(503);
  });

  it('rejects an access token used as a reset token', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const res = await request(app).post('/api/auth/reset-password').send({
      token: account.token,
      password: 'newpass99',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid reset token/i);
  });

  it('rejects a garbage reset token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({
      token: 'not-a-jwt',
      password: 'newpass99',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/change-password', () => {
  it('rejects the wrong current password', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(account.auth)
      .send({ currentPassword: 'nope-nope', newPassword: 'secret99' });

    expect(res.status).toBe(400);
  });
});

describe('legacy access tokens', () => {
  it('accepts a pre-version JWT with only id', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const legacy = jwt.sign({ id: account.user.id }, process.env.JWT_SECRET as string, {
      expiresIn: '7d',
    });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${legacy}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(account.user.id);
  });
});

describe('DELETE /api/auth/account', () => {
  it('requires the correct password and then removes the user', async () => {
    const account = await signupUser();

    const wrong = await request(app)
      .delete('/api/auth/account')
      .set(account.auth)
      .send({ password: 'wrong-password' });
    expect(wrong.status).toBe(401);

    const ok = await request(app)
      .delete('/api/auth/account')
      .set(account.auth)
      .send({ password: account.password });
    expect(ok.status).toBe(200);

    const gone = await prisma.user.findUnique({ where: { id: account.user.id } });
    expect(gone).toBeNull();

    const me = await request(app).get('/api/auth/me').set(account.auth);
    expect(me.status).toBe(401);
  });
});

function testUnknownEmail(): string {
  return `missing.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`;
}
