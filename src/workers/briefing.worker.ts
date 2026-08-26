import { Job, Worker } from 'bullmq';
import {
  briefingQueue,
  BriefingJobData,
  BRIEFING_QUEUE,
  BRIEFING_DISPATCH_JOB,
  BRIEFING_USER_JOB,
} from '../queues/briefing.queue';
import { queueConnection } from '../queues/queue.connection';
import { generateWeeklyBriefingForUser, listBriefingRecipients } from '../services/briefing.service';

let briefingWorker: Worker<BriefingJobData> | null = null;

export const startBriefingWorker = (): void => {
  if (briefingWorker) return;

  briefingWorker = new Worker<BriefingJobData>(
    BRIEFING_QUEUE,
    async (job: Job<BriefingJobData>) => {
      if (job.name === BRIEFING_DISPATCH_JOB) {
        const userIds = await listBriefingRecipients();
        console.log(`Briefing dispatch: enqueueing ${userIds.length} user briefings`);
        await briefingQueue.addBulk(
          userIds.map((userId) => ({ name: BRIEFING_USER_JOB, data: { userId } }))
        );
        return { dispatched: userIds.length };
      }

      const { userId } = job.data;
      if (!userId) throw new Error('user-briefing job missing userId');
      const result = await generateWeeklyBriefingForUser(userId);
      return result;
    },
    // Gemini + Resend per user: keep concurrency modest to respect rate limits
    { connection: queueConnection, concurrency: 3 }
  );

  briefingWorker.on('failed', (job, error) => {
    console.error(`Briefing job ${job?.id} (${job?.name}) failed:`, error.message);
  });
};

export const stopBriefingWorker = async (): Promise<void> => {
  await Promise.all([briefingWorker?.close(), briefingQueue.close()]);
  briefingWorker = null;
};
