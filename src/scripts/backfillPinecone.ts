/**
 * Embed expenses that are missing a Pinecone vector.
 *
 * Run from `server/` against the database that should own those vectors.
 * Do not backfill a local throwaway DB into the production index.
 *
 *   pnpm pinecone:backfill              # missing Vector rows only
 *   pnpm pinecone:backfill -- --force   # re-embed every expense
 *   pnpm pinecone:backfill -- --dry-run
 */

import 'dotenv/config';
import prisma from '../config/prisma';
import { logger } from '../config/logger';
import { initPinecone, isPineconeReady } from '../services/pinecone.service';
import { storeExpenseEmbedding } from '../services/rag.service';

const BATCH = 8;
const PAUSE_MS = 400;
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const ok = await initPinecone();
  if (!ok || !isPineconeReady()) {
    throw new Error('Pinecone is not ready. Check PINECONE_API_KEY and PINECONE_INDEX_NAME.');
  }
  if (!process.env.GEMINI_API_KEY?.trim() && !process.env.GEMINI_API_KEY_BACKUP?.trim()) {
    throw new Error('GEMINI_API_KEY is required to generate embeddings.');
  }

  const expenses = force
    ? await prisma.expense.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          userId: true,
          description: true,
          amount: true,
          currency: true,
          category: true,
          date: true,
        },
      })
    : await prisma.expense.findMany({
        where: { vector: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          userId: true,
          description: true,
          amount: true,
          currency: true,
          category: true,
          date: true,
        },
      });

  logger.info({ count: expenses.length, force, dryRun }, 'Pinecone backfill candidates');
  if (dryRun || expenses.length === 0) return;

  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < expenses.length; i += BATCH) {
    const slice = expenses.slice(i, i + BATCH);
    const results = await Promise.all(slice.map((expense) => storeExpenseEmbedding(expense)));
    for (const stored of results) {
      if (stored) okCount += 1;
      else failCount += 1;
    }
    logger.info({ done: Math.min(i + BATCH, expenses.length), total: expenses.length, okCount, failCount }, 'Pinecone backfill progress');
    if (i + BATCH < expenses.length) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  logger.info({ okCount, failCount }, 'Pinecone backfill finished');
  if (failCount > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Pinecone backfill failed');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
