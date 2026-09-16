import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { asyncHandler, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { deleteCachePattern } from '../config/redis';
import {
  advanceNextRun,
  computeNextRun,
  FREQUENCIES,
  type Frequency,
} from '../services/recurringRule.service';

const MAX_RULES = 50;

// @desc    Create a recurring expense rule (usually from a detected subscription)
// @route   POST /api/recurring
// @access  Private
export const createRecurringRule = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id;
    const { description, amount, currency, category, frequency, dayOfMonth, dayOfWeek } = req.body;

    const value = Number(amount);
    if (!value || !isFinite(value) || value <= 0) {
      return next(new AppError('A positive amount is required', 400));
    }

    const freq: Frequency = FREQUENCIES.includes(frequency) ? frequency : 'monthly';

    if (freq === 'monthly' && dayOfMonth != null) {
      const day = Number(dayOfMonth);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        return next(new AppError('dayOfMonth must be between 1 and 31', 400));
      }
    }
    if (freq === 'weekly' && dayOfWeek != null) {
      const day = Number(dayOfWeek);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        return next(new AppError('dayOfWeek must be between 0 and 6', 400));
      }
    }

    const existing = await prisma.recurringRule.count({ where: { userId } });
    if (existing >= MAX_RULES) {
      return next(new AppError(`You can have at most ${MAX_RULES} recurring expenses`, 400));
    }

    const schedule = {
      dayOfMonth: freq === 'monthly' && dayOfMonth != null ? Number(dayOfMonth) : null,
      dayOfWeek: freq === 'weekly' && dayOfWeek != null ? Number(dayOfWeek) : null,
    };

    const rule = await prisma.recurringRule.create({
      data: {
        userId,
        description: String(description || '').trim() || 'Recurring expense',
        amount: value,
        currency: (currency || req.user!.currency || 'USD').toUpperCase(),
        category: String(category || 'Other'),
        frequency: freq,
        ...schedule,
        nextRunAt: computeNextRun(freq, schedule),
      },
    });

    res.status(201).json({
      success: true,
      message: 'Recurring expense saved',
      data: { rule },
    });
  }
);

// @desc    List recurring expense rules
// @route   GET /api/recurring
// @access  Private
export const getRecurringRules = asyncHandler(async (req: AuthRequest, res: Response) => {
  const rules = await prisma.recurringRule.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }],
  });

  res.json({ success: true, data: { rules } });
});

// @desc    Update a recurring rule (amount, schedule, pause/resume)
// @route   PATCH /api/recurring/:id
// @access  Private
export const updateRecurringRule = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id;
    const { id } = req.params;

    const rule = await prisma.recurringRule.findFirst({ where: { id, userId } });
    if (!rule) return next(new AppError('Recurring expense not found', 404));

    const { description, amount, category, frequency, dayOfMonth, dayOfWeek, isActive } = req.body;

    const data: Record<string, unknown> = {};
    if (typeof description === 'string' && description.trim()) data.description = description.trim();
    if (typeof category === 'string' && category.trim()) data.category = category.trim();
    if (typeof isActive === 'boolean') data.isActive = isActive;

    if (amount != null) {
      const value = Number(amount);
      if (!value || !isFinite(value) || value <= 0) {
        return next(new AppError('A positive amount is required', 400));
      }
      data.amount = value;
    }

    const freq: Frequency = FREQUENCIES.includes(frequency)
      ? frequency
      : (rule.frequency as Frequency);
    const scheduleChanged =
      FREQUENCIES.includes(frequency) || dayOfMonth !== undefined || dayOfWeek !== undefined;

    if (scheduleChanged) {
      const schedule = {
        dayOfMonth:
          freq === 'monthly'
            ? dayOfMonth !== undefined
              ? Number(dayOfMonth)
              : rule.dayOfMonth
            : null,
        dayOfWeek:
          freq === 'weekly' ? (dayOfWeek !== undefined ? Number(dayOfWeek) : rule.dayOfWeek) : null,
      };

      if (schedule.dayOfMonth != null && (schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) {
        return next(new AppError('dayOfMonth must be between 1 and 31', 400));
      }
      if (schedule.dayOfWeek != null && (schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6)) {
        return next(new AppError('dayOfWeek must be between 0 and 6', 400));
      }

      data.frequency = freq;
      data.dayOfMonth = schedule.dayOfMonth;
      data.dayOfWeek = schedule.dayOfWeek;
      data.nextRunAt = computeNextRun(freq, schedule);
    }

    // Resuming a paused rule should not backfill every missed cycle.
    if (data.isActive === true && !scheduleChanged) {
      data.nextRunAt = advanceNextRun(
        freq,
        { dayOfMonth: rule.dayOfMonth, dayOfWeek: rule.dayOfWeek },
        new Date()
      );
    }

    const updated = await prisma.recurringRule.update({ where: { id }, data });

    res.json({
      success: true,
      message: 'Recurring expense updated',
      data: { rule: updated },
    });
  }
);

// @desc    Delete a recurring rule
// @route   DELETE /api/recurring/:id
// @access  Private
export const deleteRecurringRule = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id;
    const { id } = req.params;

    const rule = await prisma.recurringRule.findFirst({ where: { id, userId } });
    if (!rule) return next(new AppError('Recurring expense not found', 404));

    await prisma.recurringRule.delete({ where: { id } });

    res.json({ success: true, message: 'Recurring expense removed' });
  }
);

// @desc    Log a recurring rule immediately (user taps "log now")
// @route   POST /api/recurring/:id/run
// @access  Private
export const runRecurringRule = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id;
    const { id } = req.params;

    const rule = await prisma.recurringRule.findFirst({ where: { id, userId } });
    if (!rule) return next(new AppError('Recurring expense not found', 404));

    const now = new Date();
    const expense = await prisma.expense.create({
      data: {
        userId,
        description: rule.description,
        amount: rule.amount,
        currency: rule.currency,
        category: rule.category,
        confidence: 1,
        rawInput: `recurring:${rule.id}`,
        date: now,
      },
    });

    await prisma.recurringRule.update({
      where: { id: rule.id },
      data: {
        lastRunAt: now,
        nextRunAt: advanceNextRun(
          rule.frequency as Frequency,
          { dayOfMonth: rule.dayOfMonth, dayOfWeek: rule.dayOfWeek },
          now
        ),
      },
    });

    await deleteCachePattern(`expenses:${userId}:*`);
    await deleteCachePattern(`summary:${userId}:*`);

    res.status(201).json({
      success: true,
      message: 'Expense logged',
      data: { expense },
    });
  }
);
