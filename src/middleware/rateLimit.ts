import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';

const passThrough: RequestHandler = (_req, _res, next) => next();

const hold: {
  general: RequestHandler;
  ai: RequestHandler;
  forgot: RequestHandler;
  otp: RequestHandler;
} = {
  general: passThrough,
  ai: passThrough,
  forgot: passThrough,
  otp: passThrough,
};

const wrap = (name: keyof typeof hold): RequestHandler => {
  const handler: RequestHandler = (req, res, next) => hold[name](req, res, next);
  return handler;
};

/** Authenticated user id from JWT payload, else IP. Token is not verified here. */
export const rateLimitKey = (req: Request): string => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = JSON.parse(
        Buffer.from(auth.split(' ')[1].split('.')[1], 'base64url').toString('utf8')
      );
      if (payload?.id) return `user:${payload.id}`;
    } catch {
      // malformed token: fall through to IP
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
