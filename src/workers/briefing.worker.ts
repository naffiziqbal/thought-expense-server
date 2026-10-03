import { Job, Worker } from 'bullmq';
import {
  briefingQueue,
  BriefingJobData,
  BRIEFING_QUEUE,
  BRIEFING_DISPATCH_JOB,
  BRIEFING_USER_JOB,
} from '../queues/briefing.queue';
import { queueConnection } from '../queues/queue.connection';
import {
  generateWeeklyBriefingForUser,
  listBriefingRecipients,
  utcIsoWeekKey,
} from '../services/briefing.service';
import { logger } from '../config/logger';
import * as Sentry from '@sentry/node';

let briefingWorker: Worker<BriefingJobData> | null = null;

export const startBriefingWorker = (): void => {
  if (briefingWorker) return;

  briefingWorker = new Worker<BriefingJobData>(
    BRIEFING_QUEUE,
    async (job: Job<BriefingJobData>) => {
      if (job.name === BRIEFING_DISPATCH_JOB) {
        const userIds = await listBriefingRecipients();
        logger.info({ count: userIds.length }, 'Enqueueing user briefings');
        const weekKey = utcIsoWeekKey();
        await briefingQueue.addBulk(
          userIds.map((userId, index) => ({
            name: BRIEFING_USER_JOB,
            data: { userId },
            opts: {
              jobId: `briefing-${weekKey}-${userId}`,
              // Spread fan-out to reduce Gemini RPM spikes (esp. free tier).
              delay: index * 15_000,
            },
          }))
        );
        return { dispatched: userIds.length };
      }

      const { userId } = job.data;
      if (!userId) throw new Error('user-briefing job missing userId');
      const result = await generateWeeklyBriefingForUser(userId, {
        includeBackupKey: false,
      });
      return result;
    },
    {
      connection: queueConnection,
      concurrency: 1,
      limiter: { max: 4, duration: 60_000 },
    }
  );

  briefingWorker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'Briefing job failed');
    Sentry.captureException(error);
  });
};

export const stopBriefingWorker = async (): Promise<void> => {
  await Promise.all([briefingWorker?.close(), briefingQueue.close()]);
  briefingWorker = null;
};
