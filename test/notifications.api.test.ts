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

describe('notification APIs', () => {
  it('reads and updates preferences', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);

    const initial = await request(app).get('/api/notifications/preferences').set(account.auth);
    expect(initial.status).toBe(200);
    expect(initial.body.data.pushEnabled).toBe(true);

    const updated = await request(app)
      .patch('/api/notifications/preferences')
      .set(account.auth)
      .send({ pushEnabled: false, budgetAlertsEnabled: false });
    expect(updated.status).toBe(200);
    expect(updated.body.data.pushEnabled).toBe(false);
    expect(updated.body.data.budgetAlertsEnabled).toBe(false);
  });

  it('registers and unregisters a device token', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const token = `ExponentPushToken[test-${account.user.id}]`;

    const registered = await request(app)
      .post('/api/notifications/register')
      .set(account.auth)
      .send({ token, platform: 'android' });
    expect(registered.status).toBe(200);

    const row = await prisma.deviceToken.findUnique({ where: { token } });
    expect(row?.userId).toBe(account.user.id);

    const unregistered = await request(app)
      .post('/api/notifications/unregister')
      .set(account.auth)
      .send({ token });
    expect(unregistered.status).toBe(200);
    expect(await prisma.deviceToken.findUnique({ where: { token } })).toBeNull();
  });

  it('test push reports no devices when none are registered', async () => {
    const account = await signupUser();
    createdIds.push(account.user.id);
    const res = await request(app).post('/api/notifications/test').set(account.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.delivered).toBe(0);
    expect(res.body.data.reason).toBe('no_devices');
  });
});
