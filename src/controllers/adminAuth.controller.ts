import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { asyncHandler, AppError } from '../middleware/error.middleware';
import { AdminAuthRequest } from '../middleware/adminAuth.middleware';

function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function adminToken(adminId: string, tokenVersion: number): string {
  const secret = process.env.JWT_SECRET as string;
  return jwt.sign({ id: adminId, ver: tokenVersion, purpose: 'admin_access' }, secret, {
    expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h',
  } as SignOptions);
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

    const token = adminToken(admin.id, admin.tokenVersion);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        admin: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
        },
        token,
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
