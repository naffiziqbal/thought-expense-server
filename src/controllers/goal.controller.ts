import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { asyncHandler, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';

const round2 = (n: number): number => Math.round(n * 100) / 100;

function withProgress<T extends { targetAmount: number; savedAmount: number }>(goal: T) {
  return {
    ...goal,
    progress: goal.targetAmount > 0 ? Math.min(1, round2(goal.savedAmount / goal.targetAmount)) : 0,
    remaining: round2(Math.max(0, goal.targetAmount - goal.savedAmount)),
  };
}

// @desc    Create a savings goal
// @route   POST /api/goals
// @access  Private
export const createGoal = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const { name, targetAmount, currency, deadline } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return next(new AppError('Goal name is required', 400));
  }
  const target = Number(targetAmount);
  if (!target || !isFinite(target) || target <= 0) {
    return next(new AppError('A positive targetAmount is required', 400));
  }

  const goal = await prisma.goal.create({
    data: {
      userId,
      name: name.trim(),
      targetAmount: target,
      currency: (currency || req.user!.currency || 'USD').toUpperCase(),
      deadline: deadline ? new Date(deadline) : null,
    },
  });

  res.status(201).json({
    success: true,
    message: 'Goal created',
    data: { goal: withProgress(goal) },
  });
});

// @desc    List goals
// @route   GET /api/goals
// @access  Private
export const getGoals = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { status } = req.query;

  const goals = await prisma.goal.findMany({
    where: {
      userId,
      ...(status ? { status: String(status) } : {}),
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });

  res.json({
    success: true,
    data: { goals: goals.map(withProgress) },
  });
});

// @desc    Update a goal (name, target, deadline, status)
// @route   PATCH /api/goals/:id
// @access  Private
export const updateGoal = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const goal = await prisma.goal.findFirst({ where: { id, userId } });
  if (!goal) return next(new AppError('Goal not found', 404));

  const { name, targetAmount, deadline, status } = req.body;
  const data: Record<string, unknown> = {};

  if (name !== undefined) {
    if (!String(name).trim()) return next(new AppError('Goal name cannot be empty', 400));
    data.name = String(name).trim();
  }
  if (targetAmount !== undefined) {
    const target = Number(targetAmount);
    if (!target || !isFinite(target) || target <= 0) {
      return next(new AppError('targetAmount must be a positive number', 400));
    }
    data.targetAmount = target;
  }
  if (deadline !== undefined) {
    data.deadline = deadline ? new Date(deadline) : null;
  }
  if (status !== undefined) {
    if (!['active', 'completed', 'archived'].includes(status)) {
      return next(new AppError('Invalid status', 400));
    }
    data.status = status;
  }

  const updated = await prisma.goal.update({ where: { id }, data });

  res.json({
    success: true,
    message: 'Goal updated',
    data: { goal: withProgress(updated) },
  });
});

// @desc    Add (or remove, with a negative amount) saved money toward a goal
// @route   POST /api/goals/:id/contribute
// @access  Private
export const contributeToGoal = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const { id } = req.params;
  const amount = Number(req.body?.amount);

  if (!amount || !isFinite(amount)) {
    return next(new AppError('A non-zero amount is required', 400));
  }

  const goal = await prisma.goal.findFirst({ where: { id, userId } });
  if (!goal) return next(new AppError('Goal not found', 404));

  const savedAmount = round2(Math.max(0, goal.savedAmount + amount));
  const completed = savedAmount >= goal.targetAmount;

  const updated = await prisma.goal.update({
    where: { id },
    data: {
      savedAmount,
      status: completed ? 'completed' : goal.status === 'completed' ? 'active' : goal.status,
    },
  });

  res.json({
    success: true,
    message: completed ? 'Goal completed — congratulations!' : 'Contribution recorded',
    data: { goal: withProgress(updated) },
  });
});

// @desc    Delete a goal
// @route   DELETE /api/goals/:id
// @access  Private
export const deleteGoal = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const goal = await prisma.goal.findFirst({ where: { id, userId } });
  if (!goal) return next(new AppError('Goal not found', 404));

  await prisma.goal.delete({ where: { id } });

  res.json({ success: true, message: 'Goal deleted' });
});
