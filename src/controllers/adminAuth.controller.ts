import bcrypt from 'bcryptjs';
import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { deleteCache, incrementCounter, setCacheNx } from '../config/redis';
import { logger } from '../config/logger';
import { sendAlert } from '../services/alerts.service';
import { verifyTotp } from '../services/totp.service';
import { asyncHandler, AppError } from '../middleware/error.middleware';
import { AdminAuthRequest } from '../middleware/adminAuth.middleware';
import {
  AdminSessionError,
  createAdminSession,
  revokeAdminSessionByRefreshToken,
  revokeAllAdminSessions,
  rotateAdminSession,
} from '../services/adminSession.service';

function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function refreshTokenFromBody(req: AdminAuthRequest): string {
  const raw = req.body?.refreshToken;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Failed sign-ins allowed per admin email before it locks. */
const MAX_FAILED_SIGN_INS = 5;
const LOCK_SECONDS = 15 * 60;

/** ADMIN_REQUIRE_TOTP=true refuses admins who haven't set up two-factor sign-in. */
function totpRequiredForAll(): boolean {
  return process.env.ADMIN_REQUIRE_TOTP === 'true';
}

function clientLabel(req: AdminAuthRequest): string[] {
  return [
    `IP: ${req.ip ?? 'unknown'}`,
    `Browser: ${(req.get('user-agent') ?? 'unknown').slice(0, 120)}`,
  ];
}

export const adminLogin = asyncHandler(
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const totp = typeof req.body?.totp === 'string' ? req.body.totp.replace(/\s/g, '') : '';

    if (!email || typeof password !== 'string') {
      return next(new AppError('Invalid email or password', 401));
    }

    // Count the attempt before checking it, per email (IPs are cheap to rotate)
    // and atomically (parallel guesses can't all slip under the limit). Unknown
    // emails count too, so the lock doesn't reveal which accounts exist.
    const failKey = `admin-login-fail:${email}`;
    const attempts = await incrementCounter(failKey, LOCK_SECONDS);
    if (attempts === null) {
      return next(
        new AppError('Sign-in is temporarily unavailable. Try again in a few minutes.', 503)
      );
    }
    if (attempts > MAX_FAILED_SIGN_INS) {
      if (attempts === MAX_FAILED_SIGN_INS + 1) {
        logger.warn({ email, ip: req.ip }, 'Admin sign-in locked after repeated failures');
        void sendAlert(
          `admin_login_locked:${email}`,
          {
            severity: 'critical',
            title: 'Admin console sign-in locked',
            lines: [
              `${MAX_FAILED_SIGN_INS} failed sign-ins for ${email}. Locked for 15 minutes.`,
              ...clientLabel(req),
            ],
          },
          LOCK_SECONDS
        );
      }
      return next(new AppError('Too many failed sign-ins. Try again in 15 minutes.', 429));
    }

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      return next(new AppError('Invalid email or password', 401));
    }

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      return next(new AppError('Invalid email or password', 401));
    }

    // Second factor. Only asked for once the password is right.
    if (admin.totpSecret) {
      if (!totp) {
        res.status(401).json({
          success: false,
          code: 'totp_required',
          message: 'Enter the 6-digit code from your authenticator app.',
        });
        return;
      }
      const step = verifyTotp(admin.totpSecret, totp);
      // Each code works once: a code seen over someone's shoulder is already spent.
      const fresh =
        step !== null && (await setCacheNx(`admin-totp-used:${admin.id}:${step}`, 1, 120)) === 'ok';
      if (!fresh) {
        res.status(401).json({
          success: false,
          code: 'totp_invalid',
          message: 'That code is wrong or already used. Wait for the next one.',
        });
        return;
      }
    } else if (totpRequiredForAll()) {
      return next(
        new AppError(
          'Two-factor sign-in is required. Ask an operator to run pnpm admin:totp for your account.',
          403
        )
      );
    }

    await deleteCache(failKey);

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await createAdminSession(admin, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Every console sign-in is announced: an unexpected one is the earliest sign of a takeover.
    void sendAlert(
      `admin_login:${admin.id}:${Date.now()}`,
      {
        severity: 'info',
        title: 'Admin console sign-in',
        lines: [
          `${admin.email}${admin.totpSecret ? ' (with two-factor code)' : ' (password only)'}`,
          ...clientLabel(req),
        ],
      },
      60
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        admin: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
        },
        ...tokens,
      },
    });
  }
);

export const adminMe = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  res.json({
    success: true,
    data: { admin: req.admin },
  });
});

/** Rotate the refresh token and issue a new access token. */
export const adminRefresh = asyncHandler(
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      const data = await rotateAdminSession(refreshTokenFromBody(req));
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof AdminSessionError) return next(new AppError(err.message, 401));
      throw err;
    }
  }
);

/** Sign out this browser by its refresh token. Always succeeds (logout must work with a dead access token). */
export const adminLogout = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  await revokeAdminSessionByRefreshToken(refreshTokenFromBody(req));
  res.json({ success: true, message: 'Signed out' });
});

/** Sign out every browser for this admin (also invalidates outstanding access tokens). */
export const adminLogoutAll = asyncHandler(async (req: AdminAuthRequest, res: Response) => {
  await revokeAllAdminSessions(req.admin!.id);
  res.json({ success: true, message: 'Signed out everywhere' });
});
