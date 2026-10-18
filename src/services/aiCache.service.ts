/**
 * Response cache for Gemini calls: an identical request (same task, instructions and
 * content) within the TTL is answered from Redis instead of paying for the model again.
 *
 * The key hashes the full request, so any change to the prompt text or the user data in
 * it is a miss — no manual invalidation needed. Set AI_RESPONSE_CACHE=off to disable.
 */
import crypto from 'crypto';
import type { Part } from '@google/generative-ai';
import { getCache, setCache } from '../config/redis';

const PREFIX = 'aicache:v1';

export type AiContents = string | Array<string | Part>;

export interface CachedAiResponse {
  text: string;
  /** What the original call cost (nano-USD), credited as savings on each hit. */
  costNanoUsd: number;
}

export function aiResponseCacheEnabled(): boolean {
  return !/^(off|false|0)$/i.test(process.env.AI_RESPONSE_CACHE ?? '');
}

export function aiResponseCacheKey(
  namespace: string,
  systemInstruction: string,
  contents: AiContents
): string {
  const hash = crypto.createHash('sha256');
  hash.update(systemInstruction).update('\0');
  for (const part of Array.isArray(contents) ? contents : [contents]) {
    if (typeof part === 'string') {
      hash.update('t:').update(part);
    } else if (part.inlineData) {
      // Hash the bytes directly rather than JSON-encoding a multi-MB base64 string.
      hash.update(`d:${part.inlineData.mimeType}:`).update(part.inlineData.data);
    } else {
      hash.update('p:').update(JSON.stringify(part));
    }
    hash.update('\0');
  }
  return `${PREFIX}:${namespace}:${hash.digest('hex')}`;
}

export async function getCachedAiResponse(key: string): Promise<CachedAiResponse | null> {
  const hit = await getCache<CachedAiResponse>(key);
  return hit && typeof hit.text === 'string' ? hit : null;
}

export async function setCachedAiResponse(
  key: string,
  value: CachedAiResponse,
  ttlSeconds: number
): Promise<void> {
  await setCache(key, value, ttlSeconds);
}
