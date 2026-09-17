import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';

const passThrough: RequestHandler = (_req, _res, next) => next();

const hold: {
  general: RequestHandler;
  ai: RequestHandler;
  forgot: RequestHandler;
  otp: RequestHandler;
  login: RequestHandler;
  signup: RequestHandler;
} = {
  general: passThrough,
  ai: passThrough,
  forgot: passThrough,
  otp: passThrough,
  login: passThrough,
  signup: passThrough,
};

const wrap = (name: keyof typeof hold): RequestHandler => {
  const handler: RequestHandler = (req, res, next) => hold[name](req, res, next);
  return handler;
};

/** Authenticated user id from a verified JWT, else IP. */
export const rateLimitKey = (req: Request): string => {
  const auth = req.headers.authorization;
  const secret = process.env.JWT_SECRET;
  if (secret && auth?.startsWith('Bearer ')) {
    try {
      const token = auth.split(' ')[1];
      const decoded = jwt.verify(token, secret) as { id?: string; purpose?: string };
      if (decoded.purpose === 'password_reset') return `ip:${req.ip}`;
      if (typeof decoded.id === 'string' && decoded.id) return `user:${decoded.id}`;
    } catch {
      // expired, forged, or malformed: fall through to IP
    }
  }
  return `ip:${req.ip}`;
};

const redisStore = (prefix: string) =>
  new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (...args: string[]) => getRedisClient().sendCommand(args),
  });

const shared = {
  standardHeaders: true as const,
  legacyHeaders: false as const,
  validate: { trustProxy: false },
};

/**
 * Call after Redis is connected. Stores are created here because RedisStore
 * SCRIPT LOADs in its constructor.
 */
export function initRateLimiters(): void {
  hold.forgot = rateLimit({
    ...shared,
    store: redisStore('forgot'),
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => `ip:${req.ip}`,
    message: 'Too many reset requests. Please try again later.',
  });

  hold.otp = rateLimit({
    ...shared,
    store: redisStore('otp'),
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => `ip:${req.ip}`,
    message: 'Too many attempts. Please try again later.',
  });

  hold.login = rateLimit({
    ...shared,
    store: redisStore('login'),
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `ip:${req.ip}`,
    message: {
      success: false,
      message: 'Too many login attempts. Please try again in a few minutes.',
    },
  });

  hold.signup = rateLimit({
    ...shared,
    store: redisStore('signup'),
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => `ip:${req.ip}`,
    message: {
      success: false,
      message: 'Too many signup attempts. Please try again in a few minutes.',
    },
  });

  if (process.env.NODE_ENV !== 'production') return;

  hold.general = rateLimit({
    ...shared,
    store: redisStore('general'),
    windowMs: 15 * 60 * 1000,
    max: 600,
    keyGenerator: rateLimitKey,
    message: {
      success: false,
      message: 'Too many requests. Please slow down and try again in a few minutes.',
    },
  });

  hold.ai = rateLimit({
    ...shared,
    store: redisStore('ai'),
    windowMs: 5 * 60 * 1000,
    max: 30,
    keyGenerator: rateLimitKey,
    message: {
      success: false,
      message: "You're going a bit fast for our AI. Please wait a few minutes and try again.",
    },
  });
}

export const generalRateLimit: RequestHandler = wrap('general');
export const aiRateLimit: RequestHandler = wrap('ai');
export const forgotPasswordLimiter: RequestHandler = wrap('forgot');
export const otpVerifyLimiter: RequestHandler = wrap('otp');
export const loginLimiter: RequestHandler = wrap('login');
export const signupLimiter: RequestHandler = wrap('signup');
