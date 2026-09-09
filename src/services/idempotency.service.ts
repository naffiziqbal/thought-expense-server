import { deleteCache, getCache, setCache, setCacheNx } from '../config/redis';
import { AppError } from '../middleware/error.middleware';
import { logger } from '../config/logger';

const PENDING_TTL_SEC = 120;
const COMPLETE_TTL_SEC = 60 * 60 * 24;

type Stored<T> =
  | { status: 'pending' }
  | { status: 'complete'; value: T };

function redisKey(operation: string, userId: string, key: string): string {
  return `idem:${operation}:${userId}:${key.trim().slice(0, 256)}`;
}

/**
 * Run `fn` once per (user, operation, key). Retries with the same key replay
 * the stored result. Missing/blank key skips idempotency. Redis down: fail open.
 */
export async function withIdempotency<T>(
  operation: string,
  userId: string,
  key: string | undefined | null,
  fn: () => Promise<T>
): Promise<T> {
  if (!key || !key.trim()) return fn();

  const cacheKey = redisKey(operation, userId, key);
  const existing = await getCache<Stored<T>>(cacheKey);
  if (existing?.status === 'complete') return existing.value;
  if (existing?.status === 'pending') {
    throw new AppError('This request is already in progress. Retry shortly with the same Idempotency-Key.', 409);
  }

  const lock = await setCacheNx(cacheKey, { status: 'pending' } satisfies Stored<T>, PENDING_TTL_SEC);
  if (lock === 'error') {
    logger.warn({ operation, userId }, 'Idempotency store unavailable, proceeding without lock');
    return fn();
  }
  if (lock === 'exists') {
    const again = await getCache<Stored<T>>(cacheKey);
    if (again?.status === 'complete') return again.value;
    throw new AppError('This request is already in progress. Retry shortly with the same Idempotency-Key.', 409);
  }

  try {
    const value = await fn();
    await setCache(cacheKey, { status: 'complete', value } satisfies Stored<T>, COMPLETE_TTL_SEC);
    return value;
  } catch (err) {
    await deleteCache(cacheKey);
    throw err;
  }
}

export function idempotencyKeyFromRequest(headerValue: string | string[] | undefined): string | undefined {
  if (Array.isArray(headerValue)) return headerValue[0];
  return headerValue;
}
