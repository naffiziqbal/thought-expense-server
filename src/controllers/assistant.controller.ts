import { Response, NextFunction } from 'express';
import { asyncHandler, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { getRedisClient } from '../config/redis';
import { buildAdvisorContext } from '../services/financialContext.service';
import {
  answerFinancialQuestion,
  explainSpendingChange,
  generateSavingsPlan,
  ChatMessage,
} from '../services/advisor.service';
import { findSimilarExpenses } from '../services/rag.service';
import { searchExpenses } from '../services/search.service';
import { logger } from '../config/logger';

/** Free tier: 5 AI-advisor requests per calendar month. Premium: unlimited. */
const FREE_MONTHLY_QUOTA = 5;

async function consumeQuota(userId: string, isPremium: boolean): Promise<number | null> {
  if (isPremium) return null;
  const now = new Date();
  const key = `assistant:quota:${userId}:${now.getFullYear()}-${now.getMonth() + 1}`;
  try {
    const client = getRedisClient();
    const used = await client.incr(key);
    if (used === 1) {
      // Expire at the end of the month (worst case: 32 days)
      await client.expire(key, 60 * 60 * 24 * 32);
    }
    if (used > FREE_MONTHLY_QUOTA) return -1;
    return FREE_MONTHLY_QUOTA - used;
  } catch (err) {
    // Redis down: don't lock users out of the feature
    logger.error({ err, userId }, 'Assistant quota check failed');
    return null;
  }
}

const quotaError = new AppError(
  `You've used your ${FREE_MONTHLY_QUOTA} free AI advisor questions this month. Upgrade to Premium for unlimited advice.`,
  403
);

// @desc    Ask the AI advisor anything about your finances
// @route   POST /api/assistant/ask
// @access  Private (free tier: limited per month)
export const ask = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const { question, history } = req.body as { question?: string; history?: ChatMessage[] };

  if (!question || typeof question !== 'string' || !question.trim()) {
    return next(new AppError('Question is required', 400));
  }
  if (question.length > 1000) {
    return next(new AppError('Question is too long (max 1000 characters)', 400));
  }

  const remaining = await consumeQuota(userId, req.user!.isPremium);
  if (remaining === -1) return next(quotaError);

  const currency = req.user!.currency || 'USD';
  const [ctx, ragMatches] = await Promise.all([
    buildAdvisorContext(userId, currency, req.user!.isPremium),
    findSimilarExpenses(userId, question, 8).catch(() => []),
  ]);

  const answer = await answerFinancialQuestion(
    question.trim(),
    ctx,
    ragMatches.map((m) => ({
      description: m.description,
      category: m.category,
      amount: m.amount,
      currency: m.currency,
      date: new Date(m.date).toISOString(),
    })),
    Array.isArray(history) ? history.slice(-10) : []
  );

  res.json({
    success: true,
    data: {
      ...answer,
      remainingFreeQuestions: remaining,
    },
  });
});

// @desc    "Why did I spend so much this month?"
// @route   POST /api/assistant/why
// @access  Private (free tier: limited per month)
export const whySpendingChanged = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;

  const remaining = await consumeQuota(userId, req.user!.isPremium);
  if (remaining === -1) return next(quotaError);

  const ctx = await buildAdvisorContext(userId, req.user!.currency || 'USD', req.user!.isPremium);
  if (ctx.currentMonth.transactionCount === 0) {
    res.json({
      success: true,
      data: {
        answer: 'No expenses recorded this month yet — add some and I can break down what is driving your spending.',
        followUps: [],
        remainingFreeQuestions: remaining,
      },
    });
    return;
  }

  const answer = await explainSpendingChange(ctx);
  res.json({
    success: true,
    data: { ...answer, remainingFreeQuestions: remaining },
  });
});

// @desc    "How can I save X next month?" — a realistic plan
// @route   POST /api/assistant/savings-plan
// @access  Private (free tier: limited per month)
export const savingsPlan = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const targetAmount = Number(req.body?.targetAmount);

  if (!targetAmount || !isFinite(targetAmount) || targetAmount <= 0) {
    return next(new AppError('A positive targetAmount is required', 400));
  }

  const remaining = await consumeQuota(userId, req.user!.isPremium);
  if (remaining === -1) return next(quotaError);

  const ctx = await buildAdvisorContext(userId, req.user!.currency || 'USD', req.user!.isPremium);
  const plan = await generateSavingsPlan(ctx, targetAmount);

  res.json({
    success: true,
    data: { plan, remainingFreeQuestions: remaining },
  });
});

// @desc    Natural-language search over expense history
// @route   GET /api/assistant/search?q=
// @access  Private (free tier searches its 3-month window)
export const search = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const q = req.query.q;

  if (!q || typeof q !== 'string' || !q.trim()) {
    return next(new AppError('Search query (q) is required', 400));
  }
  if (q.length > 300) {
    return next(new AppError('Search query is too long', 400));
  }

  const result = await searchExpenses(
    userId,
    q.trim(),
    req.user!.currency || 'USD',
    req.user!.isPremium
  );

  res.json({ success: true, data: result });
});
