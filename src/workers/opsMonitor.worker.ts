import { Worker } from 'bullmq';
import * as Sentry from '@sentry/node';
import { logger } from '../config/logger';
import { opsMonitorQueue, OPS_MONITOR_QUEUE } from '../queues/opsMonitor.queue';
import { queueConnection } from '../queues/queue.connection';
import { runOpsMonitor } from '../services/opsMonitor.service';

let opsMonitorWorker: Worker | null = null;

export const startOpsMonitorWorker = (): void => {
  if (opsMonitorWorker) return;
  opsMonitorWorker = new Worker(OPS_MONITOR_QUEUE, async () => runOpsMonitor(), {
    connection: queueConnection,
    concurrency: 1,
  });

  opsMonitorWorker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id }, 'Ops monitor run failed');
    Sentry.captureException(error);
  });
};

export const stopOpsMonitorWorker = async (): Promise<void> => {
  await Promise.all([opsMonitorWorker?.close(), opsMonitorQueue.close()]);
  opsMonitorWorker = null;
};
