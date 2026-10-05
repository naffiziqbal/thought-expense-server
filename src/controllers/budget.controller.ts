import { Response } from 'express';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import {
  convertAmountsToCurrency,
  convertLimitsToCurrency,
} from '../services/exchangeRate.service';
import { parseCategoryBudgets } from '../services/gemini.service';
import { categoryBudgetParseQueue } from '../queues/categoryBudgetParse.queue';

// @desc    Create or update monthly budget
// @route   POST /api/budgets
// @access  Private
export const upsertBudget = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const userCurrency = req.user!.currency || 'USD';
  const { month, year, total_limit } = req.body as {
    month: number;
    year: number;
    total_limit: number;
  };

  if (!month || !year || total_limit == null) {
    throw new AppError('month, year and total_limit are required', 400);
  }

  if (month < 1 || month > 12) {
    throw new AppError('Month must be between 1 and 12', 400);
  }

  if (total_limit <= 0) {
    throw new AppError('total_limit must be greater than 0', 400);
  }

  await (prisma as any).budget.upsert({
    where: {
      userId_month_year: {
        userId,
        month,
        year,
      },
    },
    // The limit is denominated in whatever currency the user is using now, and
    // is converted on read once they switch.
    update: {
      totalLimit: total_limit,
      currency: userCurrency,
    },
    create: {
      userId,
      month,
      year,
      totalLimit: total_limit,
      currency: userCurrency,
    },
  });

  res.json({
    success: true,
    message: 'Budget saved',
  });
});

// @desc    Get monthly budget with progress (current month or specified month/year via query)
// @route   GET /api/budgets/current
// @access  Private
export const getCurrentBudget = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const userCurrency = req.user!.currency || 'USD';

  const monthParam = req.query.month as string | undefined;
  const yearParam = req.query.year as string | undefined;

  const now = new Date();
  const month = monthParam ? parseInt(monthParam, 10) : now.getMonth() + 1;
  const year = yearParam ? parseInt(yearParam, 10) : now.getFullYear();

  const budget = await (prisma as any).budget.findUnique({
    where: {
      userId_month_year: {
        userId,
        month,
        year,
      },
    },
  });

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

  const expenses = await prisma.expense.findMany({
    where: {
      userId,
      date: {
        gte: monthStart,
        lte: monthEnd,
      },
    },
    select: {
      amount: true,
      currency: true,
    },
  });

  let totalSpent = 0;
  if (expenses.length > 0) {
    const converted = await convertAmountsToCurrency(
      expenses.map((e) => ({ amount: e.amount, currency: e.currency })),
      userCurrency
    );
    totalSpent = converted.reduce((sum, e) => sum + e.amount, 0);
  }

  let totalLimit: number;
  let budgetId: string | undefined;

  if (budget) {
    const [converted] = await convertLimitsToCurrency(
      [{ limit: budget.totalLimit, currency: budget.currency }],
      userCurrency
    );
    totalLimit = converted;
    budgetId = budget.id;
  } else {
    // Fall back to category budgets when no explicit total Budget exists
    const categoryBudgets = await (prisma as any).categoryBudget.findMany({
      where: { userId, month, year },
    });
    if (categoryBudgets.length === 0) {
      res.json({
        success: true,
        data: null,
      });
      return;
    }
    // Each category limit can carry its own currency, so convert before summing.
    const convertedLimits = await convertLimitsToCurrency(categoryBudgets, userCurrency);
    totalLimit = convertedLimits.reduce((sum, limit) => sum + limit, 0);
    budgetId = `category-derived-${month}-${year}`;
  }

  const remaining = totalLimit - totalSpent;
  const percentage = totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : 0;

  res.json({
    success: true,
    data: {
      id: budgetId,
      month,
      year,
      total_limit: totalLimit,
      total_spent: parseFloat(totalSpent.toFixed(2)),
      remaining: parseFloat(remaining.toFixed(2)),
      percentage,
    },
  });
});

// @desc    Get recent monthly budgets with progress
// @route   GET /api/budgets/history
// @access  Private
export const getBudgetHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const userCurrency = req.user!.currency || 'USD';
  const limit = parseInt((req.query.limit as string) || '6', 10);

  const budgets = await (prisma as any).budget.findMany({
    where: { userId },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take: limit,
  });

  // One batched conversion for every row's limit, keyed by position.
  const convertedLimits = await convertLimitsToCurrency(
    budgets.map((b: { totalLimit: number; currency: string | null }) => ({
      limit: b.totalLimit,
      currency: b.currency,
    })),
    userCurrency
  );

  const results = [];

  for (const [index, budget] of budgets.entries()) {
    const monthStart = new Date(budget.year, budget.month - 1, 1);
    const monthEnd = new Date(budget.year, budget.month, 0, 23, 59, 59, 999);

    const expenses = await prisma.expense.findMany({
      where: {
        userId,
        date: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
      select: {
        amount: true,
        currency: true,
      },
    });

    let totalSpent = 0;
    if (expenses.length > 0) {
      const converted = await convertAmountsToCurrency(
        expenses.map((e) => ({ amount: e.amount, currency: e.currency })),
        userCurrency
      );
      totalSpent = converted.reduce((sum, e) => sum + e.amount, 0);
    }

    const totalLimit = convertedLimits[index];
    const remaining = totalLimit - totalSpent;
    const percentage = totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : 0;

    results.push({
      id: budget.id,
      month: budget.month,
      year: budget.year,
      total_limit: totalLimit,
      total_spent: parseFloat(totalSpent.toFixed(2)),
      remaining: parseFloat(remaining.toFixed(2)),
      percentage,
    });
  }

  res.json({
    success: true,
    data: results,
  });
});

// @desc    Delete a budget
// @route   DELETE /api/budgets/:id
// @access  Private
export const deleteBudget = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const budget = await (prisma as any).budget.findFirst({
    where: { id, userId },
  });

  if (!budget) {
    throw new AppError('Budget not found', 404);
  }

  await (prisma as any).budget.delete({
    where: { id },
  });

  res.json({
    success: true,
    message: 'Budget deleted',
  });
});

// Parse category budgets from free text
export const parseCategoryBudgetsHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { text } = req.body as { text: string };

  if (!text || !text.trim()) {
    throw new AppError('text is required', 400);
  }

  // Get known categories from user's expenses
  const rows = await prisma.expense.findMany({
    where: { userId },
    distinct: ['category'],
    select: { category: true },
    take: 50,
  });
  const known = rows.map((r) => r.category);

  const parsed = await parseCategoryBudgets(text, known, req.user!.id);

  res.json({
    success: true,
    data: { items: parsed },
  });
});

export const enqueueParseCategoryBudgets = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { text } = req.body as { text: string };

  if (!text || !text.trim()) {
    throw new AppError('text is required', 400);
  }

  const job = await categoryBudgetParseQueue.add('parse-category-budget', {
    userId,
    text,
  });

  res.status(202).json({
    success: true,
    message: 'Category budget parsing started',
    data: { jobId: job.id },
  });
});

export const getCategoryBudgetParseJobStatus = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { jobId } = req.params;
    const job = await categoryBudgetParseQueue.getJob(jobId);

    if (!job) {
      throw new AppError('Job not found', 404);
    }

    if (job.data.userId !== userId) {
      throw new AppError('Not authorized to access this job', 403);
    }

    const state = await job.getState();
    if (state === 'completed') {
      res.json({
        success: true,
        data: {
          jobId,
          status: 'completed',
          result: job.returnvalue,
        },
      });
      return;
    }

    if (state === 'failed') {
      res.json({
        success: true,
        data: {
          jobId,
          status: 'failed',
          error: job.failedReason || 'Failed to parse category budgets',
        },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        jobId,
        status: state,
      },
    });
  }
);

// Upsert category budgets for a month
export const upsertCategoryBudgets = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const userCurrency = req.user!.currency || 'USD';
  const { month, year, items } = req.body as {
    month: number;
    year: number;
    items: { category: string; limit: number }[];
  };

  if (!month || !year || !Array.isArray(items) || items.length === 0) {
    throw new AppError('month, year and items are required', 400);
  }

  for (const item of items) {
    const category = String(item.category || '').trim();
    const limit = Number(item.limit);

    if (!category || !limit || limit <= 0) continue;

    await (prisma as any).categoryBudget.upsert({
      where: {
        userId_month_year_category: {
          userId,
          month,
          year,
          category,
        },
      },
      update: { limit, currency: userCurrency },
      create: { userId, month, year, category, limit, currency: userCurrency },
    });
  }

  res.json({ success: true, message: 'Category budgets saved' });
});

// Get category budgets with progress (current month or specified month/year via query)
export const getCurrentCategoryBudgets = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const userCurrency = req.user!.currency || 'USD';

  const monthParam = req.query.month as string | undefined;
  const yearParam = req.query.year as string | undefined;

  const now = new Date();
  const month = monthParam ? parseInt(monthParam, 10) : now.getMonth() + 1;
  const year = yearParam ? parseInt(yearParam, 10) : now.getFullYear();

  const budgets = await (prisma as any).categoryBudget.findMany({
    where: { userId, month, year },
  });

  if (budgets.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

  const expenses = await prisma.expense.findMany({
    where: {
      userId,
      date: { gte: monthStart, lte: monthEnd },
    },
    select: { amount: true, currency: true, category: true },
  });

  const byCategory = new Map<string, { amount: number; currency: string }[]>();
  for (const e of expenses) {
    const key = e.category;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push({ amount: e.amount, currency: e.currency });
  }

  const result: {
    month: number;
    year: number;
    category: string;
    limit: number;
    spent: number;
    remaining: number;
    percentage: number;
  }[] = [];

  const convertedLimits = await convertLimitsToCurrency(budgets, userCurrency);

  for (const [index, b] of budgets.entries()) {
    const rows = byCategory.get(b.category) || [];
    let spent = 0;
    if (rows.length > 0) {
      const converted = await convertAmountsToCurrency(rows, userCurrency);
      spent = converted.reduce((sum, r) => sum + r.amount, 0);
    }
    const limit = convertedLimits[index];
    const remaining = limit - spent;
    const percentage = limit > 0 ? Math.round((spent / limit) * 100) : 0;

    result.push({
      month,
      year,
      category: b.category,
      limit,
      spent: parseFloat(spent.toFixed(2)),
      remaining: parseFloat(remaining.toFixed(2)),
      percentage,
    });
  }

  res.json({ success: true, data: result });
});
