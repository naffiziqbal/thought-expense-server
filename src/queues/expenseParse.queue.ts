import { Queue } from 'bullmq';
import { queueConnection } from './queue.connection';

export const EXPENSE_PARSE_QUEUE = 'expense-parse';

export interface ExpenseParseJobData {
  userId: string;
  rawInput: string;
  create: boolean;
  userCurrency: string;
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
      attempts: 6,
      removeOnComplete: {
        age: 60 * 60 * 24,
        count: 1000,
      },
      removeOnFail: {
        age: 60 * 60 * 24 * 3,
        count: 2000,
      },
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  }
);

