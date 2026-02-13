import { Response } from 'express';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { convertAmountsToCurrency } from '../services/exchangeRate.service';

// @desc    Create or update monthly budget
// @route   POST /api/budgets
// @access  Private
export const upsertBudget = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
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
    update: {
      totalLimit: total_limit,
    },
    create: {
      userId,
      month,
      year,
      totalLimit: total_limit,
    },
  });

  res.json({
    success: true,
    message: 'Budget saved',
  });
});

// @desc    Get current monthly budget with progress
// @route   GET /api/budgets/current
// @access  Private
export const getCurrentBudget = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const userCurrency = req.user!.currency || 'USD';

  const now = new Date();
  const month = now.getMonth() + 1; // JS months are 0-based
  const year = now.getFullYear();

  const budget = await (prisma as any).budget.findUnique({
    where: {
      userId_month_year: {
        userId,
        month,
        year,
      },
    },
  });

  if (!budget) {
    res.json({
      success: true,
      data: null,
    });
    return;
  }

  // Calculate totalSpent in user's currency
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

  const totalLimit = budget.totalLimit;
  const remaining = totalLimit - totalSpent;
  const percentage = totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : 0;

  res.json({
    success: true,
    data: {
      month,
      year,
      total_limit: totalLimit,
      total_spent: parseFloat(totalSpent.toFixed(2)),
      remaining: parseFloat(remaining.toFixed(2)),
      percentage,
    },
  });
});

