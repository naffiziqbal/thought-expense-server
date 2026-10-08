import prisma from '../config/prisma';
import { logger } from '../config/logger';

const THROTTLE_MS = 60 * 60 * 1000;
const MAX_TRACKED = 50_000;

/** userId → last time we wrote lastActiveAt from this process. */
const lastTouched = new Map<string, number>();

/**
 * Record that a user made an authenticated request, at most once per hour per process.
 * In-memory throttle so it keeps working when Redis is down; a restart just costs one
 * extra write per active user. Raw SQL on purpose: a Prisma update would bump
 * User.updatedAt, which billing drift views sort by. Never blocks or fails the request.
 */
export function touchLastActive(userId: string): void {
  const now = Date.now();
  const last = lastTouched.get(userId);
  if (last !== undefined && now - last < THROTTLE_MS) return;
  if (lastTouched.size >= MAX_TRACKED) lastTouched.clear();
  lastTouched.set(userId, now);

  prisma.$executeRaw`UPDATE "User" SET "lastActiveAt" = NOW() WHERE "id" = ${userId}`.catch(
    (err) => {
      lastTouched.delete(userId);
      logger.debug({ err, userId }, 'touchLastActive failed');
    }
  );
}
