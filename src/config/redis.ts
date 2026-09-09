import { createClient, RedisClientType } from 'redis';
import { logger } from './logger';

let redisClient: RedisClientType | null = null;

export const connectRedis = async (): Promise<RedisClientType> => {
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries: number) => {
          if (retries > 10) {
            logger.error('Redis: max reconnection attempts reached');
            return new Error('Redis reconnection failed');
          }
          return retries * 100; // Exponential backoff
        }
      }
    });

    redisClient.on('error', (err: Error) => {
      logger.error({ err }, 'Redis client error');
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected');
    });

    redisClient.on('reconnecting', () => {
      logger.warn('Redis reconnecting');
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    logger.error({ err: error }, 'Redis connection error');
    throw error;
  }
};

export const getRedisClient = (): RedisClientType => {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call connectRedis first.');
  }
  return redisClient;
};

// Cache helpers
export const setCache = async (key: string, value: any, ttl: number = 3600): Promise<void> => {
  try {
    const client = getRedisClient();
    await client.setEx(key, ttl, JSON.stringify(value));
  } catch (error) {
    logger.error({ err: error }, 'Redis setCache error');
  }
};

/** SET NX. Returns `ok` if written, `exists` if the key is already set, `error` if Redis failed. */
export const setCacheNx = async (
  key: string,
  value: any,
  ttl: number
): Promise<'ok' | 'exists' | 'error'> => {
  try {
    const client = getRedisClient();
    const result = await client.set(key, JSON.stringify(value), { NX: true, EX: ttl });
    return result === 'OK' ? 'ok' : 'exists';
  } catch (error) {
    logger.error({ err: error }, 'Redis setCacheNx error');
    return 'error';
  }
};

export const getCache = async <T = any>(key: string): Promise<T | null> => {
  try {
    const client = getRedisClient();
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    logger.error({ err: error }, 'Redis getCache error');
    return null;
  }
};

export const deleteCache = async (key: string): Promise<void> => {
  try {
    const client = getRedisClient();
    await client.del(key);
  } catch (error) {
    logger.error({ err: error }, 'Redis deleteCache error');
  }
};

export const deleteCachePattern = async (pattern: string): Promise<void> => {
  try {
    const client = getRedisClient();
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
    }
  } catch (error) {
    logger.error({ err: error }, 'Redis deleteCachePattern error');
  }
};
