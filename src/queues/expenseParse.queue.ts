import { Queue } from 'bullmq';
import { queueConnection } from './queue.connection';

export const EXPENSE_PARSE_QUEUE = 'expense-parse';

/**
 * Document imports (bank statements, receipts) carry sensitive files. An
 * unreadable file won't become readable on retry, and each retry resends it to
 * Gemini, so they retry a few times and failed jobs are kept briefly. The
 * worker also wipes the file and its extracted text once the job is done.
 */
export const DOCUMENT_IMPORT_JOB_OPTIONS = {
  attempts: 3,
  removeOnFail: { age: 60 * 60 * 24 * 3, count: 500 },
} as const;

export interface LocalPreviewExpense {
  description: string;
  amount: number;
  currency?: string;
  category?: string;
  date?: string;
  rawInput?: string;
}

export interface ExpenseParseJobData {
  userId: string;
  rawInput: string;
  create: boolean;
  userCurrency: string;
  /** YYYY-MM-DD from the Quick Log date picker. Overrides Gemini's "today". */
  date?: string;
  localPreview?: LocalPreviewExpense[];
  clientBatchId?: string;
  /** Premium document import: OCR in worker, then AI parse. */
  documentBase64?: string;
  documentMime?: string;
  importFileName?: string;
  cancelled?: boolean;
}

export interface ExpenseParseJobResult {
  expenses: any[];
  created: boolean;
  needsReview: string[];
}

export const expenseParseQueue = new Queue<ExpenseParseJobData, ExpenseParseJobResult>(
  EXPENSE_PARSE_QUEUE,
  {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 30,
      removeOnComplete: {
        age: 60 * 60 * 24,
        count: 1000,
      },
      removeOnFail: {
        age: 60 * 60 * 24 * 14,
        count: 2000,
      },
      backoff: {
        type: 'exponential',
        delay: 3000,
      },
    },
  }
);
