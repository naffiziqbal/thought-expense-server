import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { connectRedis, deleteCache, getRedisClient, setCache } from '../src/config/redis';
import { deleteUsersByIds, signupUser } from './helpers';

const createdIds: string[] = [];
const touchedEmails: string[] = [];

beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  for (const email of touchedEmails) {
    for (const prefix of ['pwd-otp', 'pwd-otp-tries', 'pwd-otp-guesses', 'pwd-otp-sends']) {
      await deleteCache(`${prefix}:${email}`);
    }
  }
  await deleteUsersByIds(createdIds);
  await prisma.$disconnect();
  await getRedisClient().quit();
});

/** Flag an account the way the force-reset migration does. */
async function flaggedAccount() {
  const a = await signupUser();
  createdIds.push(a.user.id);
  touchedEmails.push(a.user.email);
  await prisma.user.update({
    where: { id: a.user.id },
    data: { passwordResetRequired: true, tokenVersion: { increment: 1 } },
  });
  return a;
}

describe('forced password reset', () => {
  it('revokes existing sessions with a reset-required code', async () => {
    const a = await flaggedAccount();

    const res = await request(app).get('/api/auth/me').set(a.auth);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('PASSWORD_RESET_REQUIRED');
  });

  it('refuses login with the right password until reset', async () => {
    const a = await flaggedAccount();

    const ok = await request(app)
      .post('/api/auth/login')
      .send({ email: a.email, password: a.password });
    expect(ok.status).toBe(403);
    expect(ok.body.code).toBe('PASSWORD_RESET_REQUIRED');
    expect(ok.body.data).toBeUndefined();

    // A wrong password doesn't reveal the account needs a reset.
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: a.email, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBeUndefined();
  });

  it('clears the requirement after a reset by emailed code', async () => {
    const a = await flaggedAccount();
    const otpHash = crypto.createHash('sha256').update('135790').digest('hex');
    await setCache(`pwd-otp:${a.email}`, { otpHash }, 600);

    const verified = await request(app)
      .post('/api/auth/verify-otp')
      .send({ email: a.email, otp: '135790' });
    expect(verified.status).toBe(200);

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: verified.body.data.resetToken, password: 'brand-new-pw' });
    expect(reset.status).toBe(200);

    // The old session stays revoked; the new password signs in normally.
    expect((await request(app).get('/api/auth/me').set(a.auth)).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: a.email, password: 'brand-new-pw' });
    expect(login.status).toBe(200);
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.data.token}`);
    expect(me.status).toBe(200);
  });
});
