import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction): void => {
  let error = { ...err };
  error.message = err.message;

  const statusForLog =
    typeof err?.statusCode === 'number'
      ? err.statusCode
      : err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError'
        ? 401
        : err?.name === 'ValidationError'
          ? 400
          : 500;
  const logPayload = { err, method: req.method, url: req.originalUrl };
  if (statusForLog >= 500) {
    logger.error(logPayload, err.message || 'Unhandled error');
  } else {
    logger.warn(logPayload, err.message || 'Request error');
  }

  // Prisma errors
  if (err.code === 'P2002') {
    error.message = 'Duplicate field value entered';
    error.statusCode = 400;
  }

  if (err.code === 'P2025') {
    error.message = 'Record not found';
    error.statusCode = 404;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error.message = 'Invalid token';
    error.statusCode = 401;
  }

  if (err.name === 'TokenExpiredError') {
    error.message = 'Token expired';
    error.statusCode = 401;
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    error.message = Object.values(err.errors).map((e: any) => e.message).join(', ');
    error.statusCode = 400;
  }

  // Multer errors (file upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    error.message = 'File too large. Maximum size is 2MB.';
    error.statusCode = 400;
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    error.message = 'Unexpected file field. Use "image" for the file input.';
    error.statusCode = 400;
  }

  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

type AsyncFunction = (req: Request, res: Response, next: NextFunction) => Promise<any>;

export const asyncHandler = (fn: AsyncFunction) => (req: Request, res: Response, next: NextFunction): void => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
