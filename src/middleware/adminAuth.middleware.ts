import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getActiveAdminForSession } from '../services/adminSession.service';
import { AppError } from './error.middleware';

interface AdminJwtPayload {
  id: string;
  ver?: number;
  sid?: string;
  purpose?: string;
}

export interface AdminAuthRequest extends Request {
  admin?: {
    id: string;
    email: string;
    name: string | null;
  };
  adminSessionId?: string;
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

      // Tokens issued before sessions existed have no sid: force a fresh login.
      if (typeof decoded.sid !== 'string' || !decoded.sid) {
        return next(new AppError('Session expired', 401));
      }

      const tokenVer = typeof decoded.ver === 'number' ? decoded.ver : 0;
      const row = await getActiveAdminForSession(decoded.sid, decoded.id, tokenVer);
      if (!row) {
        return next(new AppError('Session expired', 401));
      }

      req.adminSessionId = decoded.sid;
      req.admin = { id: row.id, email: row.email, name: row.name };
      next();
    } catch {
      return next(new AppError('Not authorized to access this route', 401));
    }
  } catch (error) {
    next(error);
  }
};
