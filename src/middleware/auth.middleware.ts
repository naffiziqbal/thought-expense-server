import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './error.middleware';
import prisma from '../config/prisma';

interface JwtPayload {
  id: string;
  ver?: number;
  purpose?: string;
}

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string | null;
    profilePicture: string | null;
    currency: string;
    isPremium: boolean;
    createdAt: Date;
  };
}

export const protect = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    let token: string | undefined;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('Not authorized to access this route', 401));
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

      if (decoded.purpose === 'password_reset' || decoded.purpose === 'admin_access') {
        return next(new AppError('Not authorized to access this route', 401));
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          email: true,
          name: true,
          profilePicture: true,
          currency: true,
          isPremium: true,
          createdAt: true,
          tokenVersion: true,
        },
      });

      if (!user) {
        return next(new AppError('User no longer exists', 401));
      }

      const { tokenVersion, ...sessionUser } = user;
      const tokenVer = typeof decoded.ver === 'number' ? decoded.ver : 0;
      if (tokenVer !== tokenVersion) {
        return next(new AppError('Not authorized to access this route', 401));
      }

      req.user = sessionUser;
      next();
    } catch {
      return next(new AppError('Not authorized to access this route', 401));
    }
  } catch (error) {
    next(error);
  }
};
