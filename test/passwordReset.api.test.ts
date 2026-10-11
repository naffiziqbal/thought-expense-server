import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { trustProxyHops } from '../src/config/proxy';
import {
  connectRedis,
  deleteCache,
  getCache,
  getRedisClient,
  incrementCounter,
  setCache,
} from '../src/config/redis';
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

/** Plant a reset code the way forgot-password does, without sending an email. */
async function plantCode(email: string, code: string) {
  const otpHash = crypto.createHash('sha256').update(code).digest('hex');
  await setCache(`pwd-otp:${email}`, { otpHash }, 600);
  await deleteCache(`pwd-otp-tries:${email}`);
}

async function account() {
  const a = await signupUser();
  createdIds.push(a.user.id);
  touchedEmails.push(a.user.email);
  return a;
}

const verify = (email: string, otp: string) =>
  request(app).post('/api/auth/verify-otp').send({ email, otp });

describe('password reset codes', () => {
  it('lets at most 5 of 20 simultaneous wrong guesses through', async () => {
    const a = await account();
    await plantCode(a.user.email, '424242');

    const results = await Promise.all(
      Array.from({ length: 20 }, () => verify(a.user.email, '000000'))
    );
    const checked = results.filter((r) => r.status === 400).length;
    const blocked = results.filter((r) => r.status === 429).length;

    expect(checked).toBe(5);
    expect(blocked).toBe(15);
    // The code is burned: even the right one no longer works.
    expect((await verify(a.user.email, '424242')).status).toBe(429);
  });

  it('caps guesses per email across new codes', async () => {
    const a = await account();
    for (let round = 0; round < 2; round++) {
      await plantCode(a.user.email, '111111');
      for (let i = 0; i < 5; i++) expect((await verify(a.user.email, '999999')).status).toBe(400);
    }
    // 10 wrong guesses this hour: a fresh code doesn't reset the budget.
    await plantCode(a.user.email, '111111');
    expect((await verify(a.user.email, '111111')).status).toBe(429);
  });

  it('issues a reset token that works exactly once', async () => {
    const a = await account();
    await plantCode(a.user.email, '135790');

    const ok = await verify(a.user.email, '135790');
    expect(ok.status).toBe(200);
    const resetToken = ok.body.data.resetToken as string;

    const first = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'fresh-pass-1' });
    expect(first.status).toBe(200);

    const again = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'attacker-pass' });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already been used/i);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: a.user.email, password: 'fresh-pass-1' });
    expect(login.status).toBe(200);
  });

  it('stops minting codes after 3 in an hour, without saying so', async () => {
    const a = await account();
    for (let i = 0; i < 3; i++) await incrementCounter(`pwd-otp-sends:${a.user.email}`, 3600);

    const res = await request(app).post('/api/auth/forgot-password').send({ email: a.user.email });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(await getCache(`pwd-otp:${a.user.email}`)).toBeNull();
  });
});

describe('client IP behind the proxy', () => {
  function ipApp(hops: number) {
    const probe = express();
    probe.set('trust proxy', hops);
    probe.get('/ip', (req, res) => {
      res.json({ ip: req.ip });
    });
    return probe;
  }

  it('ignores an IP the client wrote into X-Forwarded-For', async () => {
    // nginx appends the real address after whatever the client sent.
    const res = await request(ipApp(trustProxyHops()))
      .get('/ip')
      .set('X-Forwarded-For', '6.6.6.6, 203.0.113.9');
    expect(res.body.ip).toBe('203.0.113.9');
  });

  it('reads TRUST_PROXY_HOPS, defaulting to one proxy', () => {
    expect(trustProxyHops(undefined)).toBe(1);
    expect(trustProxyHops('')).toBe(1);
    expect(trustProxyHops('2')).toBe(2);
    expect(trustProxyHops('0')).toBe(0);
    expect(trustProxyHops('true')).toBe(1);
    expect(trustProxyHops('-1')).toBe(1);
  });
});
