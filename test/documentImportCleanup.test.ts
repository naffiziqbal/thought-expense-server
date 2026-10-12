import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DOCUMENT_IMPORT_JOB_OPTIONS,
  expenseParseQueue,
  type ExpenseParseJobData,
  type ExpenseParseJobResult,
} from '../src/queues/expenseParse.queue';
import { withDocumentCleanup } from '../src/workers/parse.worker';

afterAll(async () => {
  await expenseParseQueue.close();
});

const STATEMENT = '2026-09-02 Supermarket 2340\n2026-09-03 Ride share 185';

/** Just enough of a BullMQ job for the wrapper: data, attempts, updateData. */
function fakeJob(data: Partial<ExpenseParseJobData>, attemptsMade = 0) {
  const job = {
    id: 'job-1',
    attemptsMade,
    opts: { attempts: DOCUMENT_IMPORT_JOB_OPTIONS.attempts },
    data: {
      userId: 'u1',
      rawInput: STATEMENT,
      create: true,
      userCurrency: 'BDT',
      ...data,
    } as ExpenseParseJobData,
    async updateData(next: ExpenseParseJobData) {
      job.data = next;
    },
  };
  return job;
}

const asJob = (j: ReturnType<typeof fakeJob>) => j as unknown as Job<ExpenseParseJobData>;
const done: ExpenseParseJobResult = { expenses: [{ id: 'e1' }], created: true, needsReview: [] };

describe('document import cleanup', () => {
  const doc = {
    importFileName: 'statement.pdf',
    documentMime: 'application/pdf',
    documentBase64: 'JVBERi0xLjQK',
  };

  it('wipes the file and extracted text after a successful import', async () => {
    const job = fakeJob(doc);
    const result = await withDocumentCleanup(async () => done)(asJob(job));

    expect(result).toBe(done);
    expect(job.data.documentBase64).toBeUndefined();
    expect(job.data.rawInput).toBe('');
    // The import screen still knows what it was.
    expect(job.data.importFileName).toBe('statement.pdf');
    expect(job.data.userId).toBe('u1');
  });

  it('keeps the data on an early failure, so the retry can use it', async () => {
    const job = fakeJob(doc, 0);
    await expect(
      withDocumentCleanup(async () => {
        throw new Error('Gemini 503');
      })(asJob(job))
    ).rejects.toThrow('Gemini 503');
    expect(job.data.documentBase64).toBe(doc.documentBase64);
    expect(job.data.rawInput).toBe(STATEMENT);
  });

  it('wipes the data on the final failed attempt', async () => {
    const job = fakeJob(doc, DOCUMENT_IMPORT_JOB_OPTIONS.attempts - 1);
    await expect(
      withDocumentCleanup(async () => {
        throw new Error('Could not read any expenses from this document');
      })(asJob(job))
    ).rejects.toThrow(/could not read/i);
    expect(job.data.documentBase64).toBeUndefined();
    expect(job.data.rawInput).toBe('');
  });

  it('wipes and stops retrying when the user cancels', async () => {
    const job = fakeJob(doc, 0);
    const run = withDocumentCleanup(async () => {
      throw new Error('Import cancelled by user');
    })(asJob(job));
    await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
    expect(job.data.documentBase64).toBeUndefined();
    expect(job.data.rawInput).toBe('');
  });

  it('leaves typed Quick Log jobs alone', async () => {
    const job = fakeJob({ rawInput: 'coffee 120' });
    await withDocumentCleanup(async () => done)(asJob(job));
    expect(job.data.rawInput).toBe('coffee 120');
  });

  it('retries document imports a few times and keeps failures briefly', () => {
    expect(DOCUMENT_IMPORT_JOB_OPTIONS.attempts).toBe(3);
    expect(DOCUMENT_IMPORT_JOB_OPTIONS.removeOnFail.age).toBeLessThanOrEqual(3 * 24 * 60 * 60);
  });
});
