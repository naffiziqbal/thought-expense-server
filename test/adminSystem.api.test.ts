import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import prisma from '../src/config/prisma';
import { isBackupKey } from '../src/services/backupStorage.service';
import { testEmail } from './helpers';

let adminId: string;
let auth: { Authorization: string };

beforeAll(async () => {
  const email = testEmail('admin-system');
  const admin = await prisma.admin.create({
    data: { email, password: await bcrypt.hash('admin-secret-1', 4) },
  });
  adminId = admin.id;
  const res = await request(app)
    .post('/api/admin/auth/login')
    .send({ email, password: 'admin-secret-1' });
  auth = { Authorization: `Bearer ${res.body.data.token}` };
});

afterAll(async () => {
  await prisma.admin.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe('GET /api/admin/system/health', () => {
  it('reports database, migrations and deploy info', async () => {
    const res = await request(app).get('/api/admin/system/health').set(auth);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.database.ok).toBe(true);
    expect(d.database.version).toMatch(/PostgreSQL/);
    // globalSetup ran `migrate deploy`, so nothing should be pending.
    expect(d.migrations.historyMissing).toBe(false);
    expect(d.migrations.pending).toEqual([]);
    expect(d.migrations.total).toBeGreaterThan(0);
    expect(d.deploy.startedAt).toBeTruthy();
  });

  it('requires an admin session', async () => {
    expect((await request(app).get('/api/admin/system/health')).status).toBe(401);
  });
});

describe('backup download links', () => {
  it('only accepts dump files under the backup prefix', () => {
    expect(isBackupKey('thoughtexpense/db/db_2026-10-07_21-00-02.dump')).toBe(true);
    expect(isBackupKey('thoughtexpense/db/../secrets.dump')).toBe(false);
    expect(isBackupKey('thoughtexpense/db/nested/x.dump')).toBe(false);
    expect(isBackupKey('avatars/me.png')).toBe(false);
  });

  it('rejects keys outside the backup folder without creating a link', async () => {
    const res = await request(app)
      .post('/api/admin/system/backups/link')
      .set(auth)
      .send({ key: 'avatars/someone.png' });
    expect(res.status).toBe(404);
    const logged = await prisma.adminAuditLog.count({
      where: { adminId, action: 'backup.download_link' },
    });
    expect(logged).toBe(0);
  });
});
