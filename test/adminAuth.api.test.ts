import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { connectRedis, getRedisClient } from '../src/config/redis';
import { testEmail } from './helpers';

const password = 'admin-secret-1';
const adminIds: string[] = [];

async function createAdmin() {
  const email = testEmail('admin-test');
  const admin = await prisma.admin.create({
    data: { email, password: await bcrypt.hash(password, 4), name: 'Test Admin' },
  });
  adminIds.push(admin.id);
  return admin;
}

async function login(email: string) {
  const res = await request(app).post('/api/admin/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data as { token: string; refreshToken: string; accessTokenExpiresAt: string };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let email: string;

beforeAll(async () => {
  // Admin sign-in counts failures in Redis and refuses without it.
  await connectRedis();
  email = (await createAdmin()).email;
});

afterAll(async () => {
  await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
  await prisma.$disconnect();
  await getRedisClient().quit();
});

describe('admin sessions', () => {
  it('issues an access + refresh token pair on login', async () => {
    const s = await login(email);
    expect(s.refreshToken).toBeTruthy();
    expect(new Date(s.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const me = await request(app).get('/api/admin/auth/me').set(bearer(s.token));
    expect(me.status).toBe(200);
    expect(me.body.data.admin.email).toBe(email);
  });

  it('rotates the refresh token and revokes the session when an old one is replayed', async () => {
    const s = await login(email);

    const r1 = await request(app)
      .post('/api/admin/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.data.refreshToken).not.toBe(s.refreshToken);

    // Replaying the rotated token = leaked token → whole session dies.
    const replay = await request(app)
      .post('/api/admin/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);

    const r2 = await request(app)
      .post('/api/admin/auth/refresh')
      .send({ refreshToken: r1.body.data.refreshToken });
    expect(r2.status).toBe(401);

    const me = await request(app).get('/api/admin/auth/me').set(bearer(r1.body.data.token));
    expect(me.status).toBe(401);
  });

  it('logout revokes the session immediately, including its access token', async () => {
    const s = await login(email);
    const out = await request(app)
      .post('/api/admin/auth/logout')
      .send({ refreshToken: s.refreshToken });
    expect(out.status).toBe(200);

    expect((await request(app).get('/api/admin/auth/me').set(bearer(s.token))).status).toBe(401);
    expect(
      (await request(app).post('/api/admin/auth/refresh').send({ refreshToken: s.refreshToken }))
        .status
    ).toBe(401);
  });

  it('logout-all signs out every session for the admin', async () => {
    const a = await login(email);
    const b = await login(email);

    const res = await request(app).post('/api/admin/auth/logout-all').set(bearer(a.token));
    expect(res.status).toBe(200);

    for (const s of [a, b]) {
      expect((await request(app).get('/api/admin/auth/me').set(bearer(s.token))).status).toBe(401);
      expect(
        (await request(app).post('/api/admin/auth/refresh').send({ refreshToken: s.refreshToken }))
          .status
      ).toBe(401);
    }
  });

  it('rejects legacy access tokens without a session id', async () => {
    const admin = await prisma.admin.findUniqueOrThrow({ where: { email } });
    const legacy = jwt.sign(
      { id: admin.id, ver: admin.tokenVersion, purpose: 'admin_access' },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' }
    );
    const res = await request(app).get('/api/admin/stats/overview').set(bearer(legacy));
    expect(res.status).toBe(401);
  });

  it('rejects an expired session on refresh', async () => {
    const s = await login(email);
    await prisma.adminSession.updateMany({
      where: { adminId: { in: adminIds }, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(app)
      .post('/api/admin/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
  });
});
