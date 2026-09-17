import { Errors, Index, Pinecone } from '@pinecone-database/pinecone';
import { logger } from '../config/logger';

/** Must match gemini-embedding-001 default output and the live index. */
export const EMBEDDING_DIMENSIONS = 3072;

const METADATA_STRING_MAX = 512;
const READY_WAIT_MS = 60_000;
const READY_POLL_MS = 2_000;

let pinecone: Pinecone | null = null;
let index: Index | null = null;
let ready = false;

type VectorMetadata = Record<string, string | number | boolean>;

export function isPineconeReady(): boolean {
  return ready;
}

function configuredApiKey(): string | null {
  const key = process.env.PINECONE_API_KEY?.trim();
  if (!key) return null;
  if (/^(local-dummy|your-pinecone|changeme|test)$/i.test(key)) return null;
  return key;
}

export function pineconeIndexName(): string {
  return process.env.PINECONE_INDEX_NAME?.trim() || 'thoughtexpense-embeddings';
}

function isMissingIndexError(err: unknown): boolean {
  if (err instanceof Errors.PineconeNotFoundError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /404|not found|does not exist/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

/** Pinecone metadata allows string | number | boolean | string[] only — no null/NaN/objects. */
export function pineconeMetadata(input: {
  userId?: string;
  expenseId?: string;
  description?: string;
  category?: string;
  amount?: number;
  currency?: string;
}): VectorMetadata {
  const meta: VectorMetadata = {};
  if (input.userId) meta.userId = clip(String(input.userId), 80);
  if (input.expenseId) meta.expenseId = clip(String(input.expenseId), 80);
  if (input.description) meta.description = clip(String(input.description), METADATA_STRING_MAX);
  if (input.category) meta.category = clip(String(input.category), 80);
  if (typeof input.amount === 'number' && Number.isFinite(input.amount)) {
    meta.amount = input.amount;
  }
  if (input.currency) meta.currency = clip(String(input.currency).toUpperCase(), 8);
  meta.timestamp = new Date().toISOString();
  return meta;
}

export function isValidEmbedding(values: unknown): boolean {
  return (
    Array.isArray(values) &&
    values.length === EMBEDDING_DIMENSIONS &&
    values.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

async function waitUntilIndexReady(client: Pinecone, indexName: string): Promise<void> {
  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline) {
    const description = await client.describeIndex(indexName);
    if (description.status?.ready) return;
    logger.info({ indexName, state: description.status?.state }, 'Waiting for Pinecone index');
    await sleep(READY_POLL_MS);
  }
  throw new Error(`Pinecone index ${indexName} was not ready within ${READY_WAIT_MS}ms`);
}

/**
 * Connect and verify the index. Returns false when skipped or unreachable —
 * the API still starts. Does not create an index unless PINECONE_CREATE_INDEX=true
 * (a typo in PINECONE_INDEX_NAME must not spin up an empty index).
 */
export const initPinecone = async (): Promise<boolean> => {
  ready = false;
  pinecone = null;
  index = null;

  const apiKey = configuredApiKey();
  if (!apiKey) {
    logger.warn('Pinecone skipped: PINECONE_API_KEY is empty or a placeholder');
    return false;
  }

  const indexName = pineconeIndexName();

  try {
    const client = new Pinecone({ apiKey });

    let description;
    try {
      description = await client.describeIndex(indexName);
    } catch (err) {
      if (!isMissingIndexError(err)) throw err;
      const allowCreate = process.env.PINECONE_CREATE_INDEX === 'true';
      if (!allowCreate) {
        logger.error(
          { indexName },
          'Pinecone index not found. Set PINECONE_INDEX_NAME to an existing index, or PINECONE_CREATE_INDEX=true to create one'
        );
        return false;
      }
      logger.warn({ indexName }, 'Pinecone index missing; creating serverless cosine index');
      await client.createIndex({
        name: indexName,
        dimension: EMBEDDING_DIMENSIONS,
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: (process.env.PINECONE_CLOUD as 'aws' | 'gcp' | 'azure') || 'aws',
            region: process.env.PINECONE_REGION || 'us-east-1',
          },
        },
        waitUntilReady: true,
      });
      description = await client.describeIndex(indexName);
    }

    if (!description.status?.ready) {
      await waitUntilIndexReady(client, indexName);
      description = await client.describeIndex(indexName);
    }

    const dimension = description.dimension;
    if (dimension && dimension !== EMBEDDING_DIMENSIONS) {
      logger.error(
        { indexName, dimension, expected: EMBEDDING_DIMENSIONS },
        'Pinecone index dimension does not match gemini-embedding-001; semantic search disabled'
      );
      return false;
    }

    pinecone = client;
    index = client.index(indexName);
    const stats = await index.describeIndexStats();
    ready = true;
    logger.info(
      {
        indexName,
        dimension: dimension || stats.dimension,
        vectors: stats.totalRecordCount ?? 0,
        state: description.status?.state,
      },
      'Pinecone ready'
    );
    return true;
  } catch (error) {
    pinecone = null;
    index = null;
    ready = false;
    logger.error({ err: error, indexName }, 'Pinecone initialization failed');
    return false;
  }
};

export const getIndex = (): Index => {
  if (!ready || !index) {
    throw new Error('Pinecone is not ready');
  }
  return index;
};

export const upsertExpenseVector = async (
  expenseId: string,
  embedding: number[],
  metadata: {
    userId?: string;
    description?: string;
    category?: string;
    amount?: number;
    currency?: string;
  } = {}
): Promise<boolean> => {
  if (!ready) return false;
  if (!expenseId) return false;
  if (!isValidEmbedding(embedding)) {
    logger.error(
      { expenseId, got: Array.isArray(embedding) ? embedding.length : typeof embedding },
      'Invalid embedding; skip Pinecone upsert'
    );
    return false;
  }
  try {
    const idx = getIndex();
    await idx.upsert([
      {
        id: expenseId,
        values: embedding,
        metadata: pineconeMetadata({ ...metadata, expenseId }),
      },
    ]);
    return true;
  } catch (error) {
    logger.error({ err: error, expenseId }, 'Pinecone upsert error');
    return false;
  }
};

export const querySimilarExpenses = async (
  embedding: number[],
  userId: string,
  topK: number = 5
): Promise<Array<{ id?: string; score?: number; metadata?: Record<string, unknown> }>> => {
  if (!ready || !userId) return [];
  if (!isValidEmbedding(embedding)) {
    logger.warn({ got: Array.isArray(embedding) ? embedding.length : typeof embedding }, 'Skip Pinecone query: bad embedding');
    return [];
  }
  const k = Math.min(Math.max(1, Math.floor(topK) || 5), 100);
  try {
    const idx = getIndex();
    const results = await idx.query({
      vector: embedding,
      topK: k,
      filter: { userId },
      includeMetadata: true,
    });
    return results.matches || [];
  } catch (error) {
    logger.error({ err: error }, 'Pinecone query error');
    return [];
  }
};

export const deleteExpenseVector = async (expenseId: string): Promise<boolean> => {
  if (!ready || !expenseId) return false;
  try {
    const idx = getIndex();
    await idx.deleteOne(expenseId);
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Pinecone delete error');
    return false;
  }
};

export const deleteUserVectors = async (userId: string): Promise<boolean> => {
  if (!ready || !userId) return false;
  try {
    const idx = getIndex();
    await idx.deleteMany({ userId });
    return true;
  } catch (error) {
    logger.error({ err: error, userId }, 'Pinecone delete user vectors error');
    return false;
  }
};
