import { Queue } from 'bullmq';
import { queueConnection } from './queue.connection';

export const BRIEFING_QUEUE = 'weekly-briefing';

/** The repeatable dispatch job fans out one `user-briefing` job per active user. */
export const BRIEFING_DISPATCH_JOB = 'dispatch-briefings';
export const BRIEFING_USER_JOB = 'user-briefing';

export interface BriefingJobData {
  userId?: string; // present on user-briefing jobs, absent on dispatch
}

export const briefingQueue = new Queue<BriefingJobData>(BRIEFING_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    removeOnComplete: { age: 60 * 60 * 24 * 7, count: 5000 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
    backoff: { type: 'exponential', delay: 30000 },
  },
});

/**
 * Register the weekly schedule (Mondays 08:00 server time). Idempotent —
 * upsertJobScheduler replaces any previous schedule with the same id.
 * Override with BRIEFING_CRON, e.g. "0 8 * * 1".
 */
export const registerBriefingSchedule = async (): Promise<void> => {
  const pattern = process.env.BRIEFING_CRON || '0 8 * * 1';
  await briefingQueue.upsertJobScheduler(
    'weekly-briefing-schedule',
    { pattern },
    { name: BRIEFING_DISPATCH_JOB, data: {} }
  );
};
