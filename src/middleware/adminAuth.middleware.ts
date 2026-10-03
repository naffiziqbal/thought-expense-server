import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/prisma';
import { AppError } from './error.middleware';

interface AdminJwtPayload {
  id: string;
  ver?: number;
  purpose?: string;
}

export interface AdminAuthRequest extends Request {
  admin?: {
    id: string;
    email: string;
    name: string | null;
  };
}

export const protectAdmin = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return next(new AppError('Not authorized to access this route', 401));
    }

    const token = header.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AdminJwtPayload;
      if (decoded.purpose !== 'admin_access') {
        return next(new AppError('Not authorized to access this route', 401));
      }

      const row = await prisma.admin.findUnique({
        where: { id: decoded.id },
        select: { id: true, email: true, name: true, tokenVersion: true },
      });

      if (!row) {
        return next(new AppError('Admin account no longer exists', 401));
      }

      const tokenVer = typeof decoded.ver === 'number' ? decoded.ver : 0;
      if (tokenVer !== row.tokenVersion) {
        return next(new AppError('Not authorized to access this route', 401));
      }

      req.admin = { id: row.id, email: row.email, name: row.name };
      next();
    } catch {
      return next(new AppError('Not authorized to access this route', 401));
    }
  } catch (error) {
    next(error);
  }
};
