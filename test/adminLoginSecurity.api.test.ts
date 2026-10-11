import { execFileSync } from 'node:child_process';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { connectRedis, deleteCache, getRedisClient } from '../src/config/redis';
import {
  base32Encode,
  currentStep,
  generateTotpSecret,
  totpAt,
  verifyTotp,
} from '../src/services/totp.service';
import { testEmail } from './helpers';

const password = 'console-pass-123';
const adminIds: string[] = [];
const emails: string[] = [];

beforeAll(async () => {
  await connectRedis();
});

afterEach(() => {
  delete process.env.ADMIN_REQUIRE_TOTP;
});

afterAll(async () => {
  for (const e of emails) await deleteCache(`admin-login-fail:${e}`);
  await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
  await prisma.$disconnect();
  await getRedisClient().quit();
});

async function createAdmin(totpSecret?: string) {
  const email = testEmail('admin-sec');
  const admin = await prisma.admin.create({
    data: { email, password: await bcrypt.hash(password, 4), totpSecret: totpSecret ?? null },
  });
  adminIds.push(admin.id);
  emails.push(email);
  return admin;
}

const login = (body: Record<string, string>) =>
  request(app).post('/api/admin/auth/login').send(body);

describe('TOTP codes', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // T = 59s is step 1; the RFC's 8-digit code is 94287082.
    expect(totpAt(secret, 1)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(1);
  });

  it('accepts one step of clock drift but not two', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const step = currentStep(now);
    expect(verifyTotp(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
});

describe('admin sign-in lockout', () => {
  it('locks the account after 5 failures, even for the right password', async () => {
    const admin = await createAdmin();
    for (let i = 0; i < 5; i++) {
      expect((await login({ email: admin.email, password: 'wrong-password-x' })).status).toBe(401);
    }
    const res = await login({ email: admin.email, password });
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/15 minutes/);
  });

  it('lets only 5 of 20 simultaneous guesses reach the password check', async () => {
    const admin = await createAdmin();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login({ email: admin.email, password: 'wrong-password-x' }))
    );
    expect(results.filter((r) => r.status === 401).length).toBe(5);
    expect(results.filter((r) => r.status === 429).length).toBe(15);
  });

  it('locks unknown emails the same way, so the lock reveals nothing', async () => {
    const email = testEmail('nobody-admin');
    emails.push(email);
    for (let i = 0; i < 5; i++) expect((await login({ email, password })).status).toBe(401);
    expect((await login({ email, password })).status).toBe(429);
  });

  it('clears the failure count after a good sign-in', async () => {
    const admin = await createAdmin();
    for (let i = 0; i < 4; i++) await login({ email: admin.email, password: 'wrong-password-x' });
    expect((await login({ email: admin.email, password })).status).toBe(200);
    for (let i = 0; i < 4; i++) await login({ email: admin.email, password: 'wrong-password-x' });
    expect((await login({ email: admin.email, password })).status).toBe(200);
  });
});

describe('admin two-factor sign-in', () => {
  it('asks for a code only after the password is right', async () => {
    const admin = await createAdmin(generateTotpSecret());
    const wrong = await login({ email: admin.email, password: 'wrong-password-x' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBeUndefined();

    const res = await login({ email: admin.email, password });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('totp_required');
    expect(res.body.data).toBeUndefined();
  });

  it('signs in with a current code, and refuses the same code twice', async () => {
    const secret = generateTotpSecret();
    const admin = await createAdmin(secret);
    const code = totpAt(secret, currentStep());

    const ok = await login({ email: admin.email, password, totp: code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.token).toBeTruthy();

    const replay = await login({ email: admin.email, password, totp: code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('totp_invalid');
  });

  it('refuses a wrong code', async () => {
    const secret = generateTotpSecret();
    const admin = await createAdmin(secret);
    const wrong = totpAt(secret, currentStep() + 5);
    const res = await login({ email: admin.email, password, totp: wrong });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('totp_invalid');
  });

  it('with ADMIN_REQUIRE_TOTP, refuses admins who have not set it up', async () => {
    process.env.ADMIN_REQUIRE_TOTP = 'true';
    const admin = await createAdmin();
    const res = await login({ email: admin.email, password });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/admin:totp/);
  });
});

describe('pnpm admin:create', () => {
  it('refuses passwords shorter than 12 characters', () => {
    const root = path.resolve(__dirname, '..');
    let failed = false;
    try {
      execFileSync(
        'npx',
        [
          'ts-node',
          'src/scripts/createAdmin.ts',
          '--email',
          testEmail('short'),
          '--password',
          'short-pass1',
        ],
        {
          cwd: root,
          stdio: 'pipe',
          env: process.env,
        }
      );
    } catch (err) {
      failed = true;
      expect(String((err as { stderr?: Buffer }).stderr)).toMatch(/12 characters/);
    }
    expect(failed).toBe(true);
  });
});
