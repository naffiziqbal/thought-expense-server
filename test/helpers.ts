import request from 'supertest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';

export function testEmail(prefix = 'api-test'): string {
  return `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}@example.com`;
}

export async function signupUser(overrides?: {
  email?: string;
  password?: string;
  name?: string;
  currency?: string;
}) {
  const email = overrides?.email ?? testEmail();
  const password = overrides?.password ?? 'secret12';
  const res = await request(app)
    .post('/api/auth/signup')
    .send({
      email,
      password,
      name: overrides?.name ?? 'API Tester',
      currency: overrides?.currency,
    });

  if (res.status !== 201 || !res.body?.data?.token) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    email,
    password,
    token: res.body.data.token as string,
    user: res.body.data.user as { id: string; email: string },
    auth: { Authorization: `Bearer ${res.body.data.token}` },
  };
}

export async function createExpense(
  auth: { Authorization: string },
  data: {
    description: string;
    amount: number;
    category?: string;
    date?: string;
    currency?: string;
  }
) {
  const res = await request(app).post('/api/expenses').set(auth).send(data);
  if (res.status !== 201) {
    throw new Error(`createExpense failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.expense as { id: string; description: string; amount: number; userId: string };
}

export async function setPremium(userId: string, isPremium: boolean): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      isPremium,
      subscriptionStatus: isPremium ? 'active' : 'expired',
      premiumUntil: isPremium ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
    },
  });
}

export async function deleteUsersByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
