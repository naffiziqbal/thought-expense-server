import { Queue } from 'bullmq';
import { queueConnection } from './queue.connection';

export const OPS_MONITOR_QUEUE = 'ops-monitor';
export const OPS_MONITOR_JOB = 'run-checks';

export const opsMonitorQueue = new Queue(OPS_MONITOR_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 1, // the next scheduled run is the retry
    removeOnComplete: { age: 60 * 60 * 24, count: 200 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 200 },
  },
});

/**
 * Run ops checks every 15 minutes. Idempotent (upsertJobScheduler).
 * Override with OPS_MONITOR_CRON, e.g. "*\/5 * * * *".
 */
export const registerOpsMonitorSchedule = async (): Promise<void> => {
  const pattern = process.env.OPS_MONITOR_CRON || '*/15 * * * *';
  await opsMonitorQueue.upsertJobScheduler(
    'ops-monitor-schedule',
    { pattern },
    { name: OPS_MONITOR_JOB, data: {} }
  );
};
