import { Queue } from 'bullmq';
import { queueConnection } from './queue.connection';

export const CATEGORY_BUDGET_PARSE_QUEUE = 'category-budget-parse';

export interface CategoryBudgetParseJobData {
  userId: string;
  text: string;
}

export interface CategoryBudgetParseJobResult {
  items: Array<{
    category: string;
    limit: number;
  }>;
}

export const categoryBudgetParseQueue = new Queue<
  CategoryBudgetParseJobData,
  CategoryBudgetParseJobResult
>(CATEGORY_BUDGET_PARSE_QUEUE, {
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
});

