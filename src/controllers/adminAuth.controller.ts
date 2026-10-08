import bcrypt from 'bcryptjs';
import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
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

export const adminLogin = asyncHandler(
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!email || typeof password !== 'string') {
      return next(new AppError('Invalid email or password', 401));
    }

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      return next(new AppError('Invalid email or password', 401));
    }

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      return next(new AppError('Invalid email or password', 401));
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await createAdminSession(admin, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

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
