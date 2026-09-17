import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { deleteUsersByIds, signupUser } from './helpers';

const createdIds: string[] = [];
const secret = () => process.env.JWT_SECRET as string;

afterAll(async () => {
  await deleteUsersByIds(createdIds);
  await prisma.$disconnect();
});

describe('session revocation', () => {
  it('rejects a password-reset JWT on authenticated routes', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const resetToken = jwt.sign(
      { id: account.user.id, email: account.email, purpose: 'password_reset' },
      secret(),
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${resetToken}`);

    expect(res.status).toBe(401);
  });

  it('invalidates the previous access token after change-password', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const changed = await request(app)
      .post('/api/auth/change-password')
      .set(account.auth)
      .send({ currentPassword: account.password, newPassword: 'secret99' });

    expect(changed.status).toBe(200);
    const nextToken = changed.body.data.token as string;
    expect(nextToken).toBeTruthy();
    expect(nextToken).not.toBe(account.token);

    const withOld = await request(app).get('/api/auth/me').set(account.auth);
    expect(withOld.status).toBe(401);

    const withNew = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${nextToken}`);
    expect(withNew.status).toBe(200);
    expect(withNew.body.data.user.id).toBe(account.user.id);
  });

  it('rejects a forged tokenVersion', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const bumped = jwt.sign(
      { id: account.user.id, ver: 99, purpose: 'access' },
      secret(),
      { expiresIn: '7d' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${bumped}`);

    expect(res.status).toBe(401);
  });
});
