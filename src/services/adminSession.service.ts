import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import prisma from '../config/prisma';
import { logger } from '../config/logger';
import { sendAlert } from './alerts.service';

/**
 * Admin console sessions.
 *
 * - Access token: short-lived JWT ({ id, ver, sid, purpose: 'admin_access' }).
 * - Refresh token: opaque random string, stored only as a sha256 hash on AdminSession and
 *   rotated on every refresh. Presenting the previous (already rotated) token again means it
 *   leaked, so the whole session is revoked.
 * - A session dies when revoked (logout / reuse / sign-out-everywhere), when the admin's
 *   tokenVersion changes, after ADMIN_SESSION_IDLE_HOURS without a refresh, or at
 *   ADMIN_SESSION_TTL_DAYS after login.
 */

const ACCESS_TTL = process.env.ADMIN_ACCESS_TOKEN_TTL || '15m';
const SESSION_TTL_MS = (Number(process.env.ADMIN_SESSION_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;
const IDLE_TTL_MS = (Number(process.env.ADMIN_SESSION_IDLE_HOURS) || 24) * 60 * 60 * 1000;

export type AdminSessionRevokeReason =
  | 'logout'
  | 'logout_all'
  | 'reuse_detected'
  | 'password_reset'
  | 'expired'
  | 'idle'
  | 'token_version';

export interface AdminSessionTokens {
  token: string;
  refreshToken: string;
  /** ISO time the access token expires (client refreshes shortly before). */
  accessTokenExpiresAt: string;
  sessionExpiresAt: string;
}

export class AdminSessionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

function signAccessToken(adminId: string, tokenVersion: number, sessionId: string): string {
  return jwt.sign(
    { id: adminId, ver: tokenVersion, sid: sessionId, purpose: 'admin_access' },
    process.env.JWT_SECRET as string,
    { expiresIn: ACCESS_TTL } as SignOptions
  );
}

function issueTokens(
  adminId: string,
  tokenVersion: number,
  sessionId: string,
  refreshToken: string,
  sessionExpiresAt: Date
): AdminSessionTokens {
  const token = signAccessToken(adminId, tokenVersion, sessionId);
  const { exp } = jwt.decode(token) as { exp: number };
  return {
    token,
    refreshToken,
    accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
    sessionExpiresAt: sessionExpiresAt.toISOString(),
  };
}

export async function createAdminSession(
  admin: { id: string; tokenVersion: number },
  meta: { ipAddress?: string | null; userAgent?: string | null }
): Promise<AdminSessionTokens> {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await prisma.adminSession.create({
    data: {
      adminId: admin.id,
      tokenHash: hashToken(refreshToken),
      tokenVersion: admin.tokenVersion,
      expiresAt,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
  });

  // Housekeeping: drop this admin's long-dead sessions.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  void prisma.adminSession
    .deleteMany({
      where: {
        adminId: admin.id,
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    })
    .catch((err) => logger.debug({ err }, 'admin session cleanup failed'));

  return issueTokens(admin.id, admin.tokenVersion, session.id, refreshToken, expiresAt);
}

async function revokeSession(id: string, reason: AdminSessionRevokeReason): Promise<void> {
  await prisma.adminSession.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** Rotate a refresh token. Throws AdminSessionError when the session can't continue. */
export async function rotateAdminSession(
  refreshToken: string
): Promise<AdminSessionTokens & { admin: { id: string; email: string; name: string | null } }> {
  if (!refreshToken) throw new AdminSessionError('Session expired');
  const hash = hashToken(refreshToken);

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hash },
    include: { admin: { select: { id: true, email: true, name: true, tokenVersion: true } } },
  });

  if (!session) {
    const reused = await prisma.adminSession.findUnique({ where: { prevTokenHash: hash } });
    if (reused && !reused.revokedAt) {
      await revokeSession(reused.id, 'reuse_detected');
      logger.warn(
        { sessionId: reused.id, adminId: reused.adminId },
        'Admin refresh token reuse detected; session revoked'
      );
      void sendAlert(`admin_token_reuse:${reused.id}`, {
        severity: 'critical',
        title: 'Admin session token reused',
        lines: [
          `Session ${reused.id.slice(0, 8)} (admin ${reused.adminId.slice(0, 8)}) was revoked.`,
          'A refresh token was used twice — it may have been stolen. If this was not you, use "Sign out everywhere" and change the password.',
        ],
      });
    }
    throw new AdminSessionError('Session expired');
  }

  if (session.revokedAt) throw new AdminSessionError('Session was signed out');

  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await revokeSession(session.id, 'expired');
    throw new AdminSessionError('Session expired');
  }
  if (session.lastUsedAt.getTime() + IDLE_TTL_MS <= now) {
    await revokeSession(session.id, 'idle');
    throw new AdminSessionError('Session expired');
  }
  if (session.tokenVersion !== session.admin.tokenVersion) {
    await revokeSession(session.id, 'token_version');
    throw new AdminSessionError('Session was signed out');
  }

  const next = newRefreshToken();
  // Conditional on the old hash so two concurrent refreshes can't both win.
  const { count } = await prisma.adminSession.updateMany({
    where: { id: session.id, tokenHash: hash, revokedAt: null },
    data: {
      prevTokenHash: hash,
      tokenHash: hashToken(next),
      rotatedAt: new Date(),
      lastUsedAt: new Date(),
    },
  });
  if (count === 0) throw new AdminSessionError('Session expired');

  const { admin } = session;
  return {
    ...issueTokens(admin.id, admin.tokenVersion, session.id, next, session.expiresAt),
    admin: { id: admin.id, email: admin.email, name: admin.name },
  };
}

/** Revoke the session a refresh token belongs to (current or just-rotated token). */
export async function revokeAdminSessionByRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return;
  const hash = hashToken(refreshToken);
  await prisma.adminSession.updateMany({
    where: { OR: [{ tokenHash: hash }, { prevTokenHash: hash }], revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'logout' },
  });
}

/** Kill every session for an admin: bumps tokenVersion so outstanding access tokens die too. */
export async function revokeAllAdminSessions(
  adminId: string,
  reason: AdminSessionRevokeReason = 'logout_all'
): Promise<void> {
  await prisma.$transaction([
    prisma.admin.update({ where: { id: adminId }, data: { tokenVersion: { increment: 1 } } }),
    prisma.adminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    }),
  ]);
}

/** Validate the session an access token points to. Returns the admin or null. */
export async function getActiveAdminForSession(
  sessionId: string,
  adminId: string,
  tokenVersion: number
): Promise<{ id: string; email: string; name: string | null } | null> {
  const session = await prisma.adminSession.findUnique({
    where: { id: sessionId },
    select: {
      adminId: true,
      revokedAt: true,
      expiresAt: true,
      tokenVersion: true,
      admin: { select: { id: true, email: true, name: true, tokenVersion: true } },
    },
  });
  if (!session || session.adminId !== adminId || session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (session.tokenVersion !== tokenVersion || session.admin.tokenVersion !== tokenVersion)
    return null;
  return { id: session.admin.id, email: session.admin.email, name: session.admin.name };
}
