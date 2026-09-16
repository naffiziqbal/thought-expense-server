import { Job, Worker } from 'bullmq';
import * as Sentry from '@sentry/node';
import prisma from '../config/prisma';
import { logger } from '../config/logger';
import { deleteCachePattern } from '../config/redis';
import {
  recurringQueue,
  RecurringJobData,
  RECURRING_QUEUE,
  RECURRING_SWEEP_JOB,
} from '../queues/recurring.queue';
import { queueConnection } from '../queues/queue.connection';
import { advanceNextRun, type Frequency } from '../services/recurringRule.service';
import { sendPushToUser } from '../services/push.service';

let recurringWorker: Worker<RecurringJobData> | null = null;

const BATCH_LIMIT = 200;

async function sweepDueRules(): Promise<{ logged: number }> {
  const now = new Date();

  const due = await prisma.recurringRule.findMany({
    where: { isActive: true, nextRunAt: { lte: now } },
    take: BATCH_LIMIT,
  });

  if (due.length === 0) return { logged: 0 };

  const touchedUsers = new Set<string>();
  let logged = 0;

  for (const rule of due) {
    try {
      // Advance the schedule in the same transaction as the write so a crash
      // between the two cannot double-log the expense.
      await prisma.$transaction([
        prisma.expense.create({
          data: {
            userId: rule.userId,
            description: rule.description,
            amount: rule.amount,
            currency: rule.currency,
            category: rule.category,
            confidence: 1,
            rawInput: `recurring:${rule.id}`,
            date: now,
          },
        }),
        prisma.recurringRule.update({
          where: { id: rule.id },
          data: {
            lastRunAt: now,
            nextRunAt: advanceNextRun(
              rule.frequency as Frequency,
              { dayOfMonth: rule.dayOfMonth, dayOfWeek: rule.dayOfWeek },
              rule.nextRunAt,
              now
            ),
          },
        }),
      ]);

      logged += 1;
      touchedUsers.add(rule.userId);

      sendPushToUser(rule.userId, {
        title: 'Recurring expense logged',
        body: `${rule.description} — ${rule.amount} ${rule.currency}`,
        data: { screen: 'expenses' },
      }).catch(() => {});
    } catch (error) {
      logger.error({ err: error, ruleId: rule.id }, 'Failed to log recurring expense');
      Sentry.captureException(error);
    }
  }

  for (const userId of touchedUsers) {
    await deleteCachePattern(`expenses:${userId}:*`);
    await deleteCachePattern(`summary:${userId}:*`);
    await deleteCachePattern(`recurring:${userId}`);
  }

  logger.info({ logged, users: touchedUsers.size }, 'Recurring sweep complete');
  return { logged };
}

export const startRecurringWorker = (): void => {
  if (recurringWorker) return;

  recurringWorker = new Worker<RecurringJobData>(
    RECURRING_QUEUE,
    async (job: Job<RecurringJobData>) => {
      if (job.name === RECURRING_SWEEP_JOB) return sweepDueRules();
      return { logged: 0 };
    },
    { connection: queueConnection, concurrency: 1 }
  );

  recurringWorker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'Recurring job failed');
    Sentry.captureException(error);
  });
};

export const stopRecurringWorker = async (): Promise<void> => {
  await Promise.all([recurringWorker?.close(), recurringQueue.close()]);
  recurringWorker = null;
};
