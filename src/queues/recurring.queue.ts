import { Queue } from 'bullmq';
import { queueConnection } from './queue.connection';

export const RECURRING_QUEUE = 'recurring-expenses';
export const RECURRING_SWEEP_JOB = 'sweep-due-rules';

export interface RecurringJobData {
  /** Absent on the scheduled sweep; the sweep does the work inline. */
  ruleId?: string;
}

export const recurringQueue = new Queue<RecurringJobData>(RECURRING_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    removeOnComplete: { age: 60 * 60 * 24 * 3, count: 500 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 500 },
    backoff: { type: 'exponential', delay: 30000 },
  },
});

/**
 * Sweep hourly for due rules. Hourly (not daily) so a restart or a brief
 * outage delays an auto-logged expense by an hour, not a full day.
 * Override with RECURRING_CRON.
 */
export const registerRecurringSchedule = async (): Promise<void> => {
  const pattern = process.env.RECURRING_CRON || '0 * * * *';
  await recurringQueue.upsertJobScheduler(
    'recurring-sweep-schedule',
    { pattern },
    { name: RECURRING_SWEEP_JOB, data: {} }
  );
};
