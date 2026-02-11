import { Response } from 'express';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { generateInsights } from '../services/gemini.service';
import { setCache, getCache } from '../config/redis';
import { AuthRequest } from '../middleware/auth.middleware';

// @desc    Generate weekly insights
// @route   POST /api/insights/generate
// @access  Private
export const generateWeeklyInsights = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Get expenses from the past week
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const expenses = await prisma.expense.findMany({
    where: {
      userId,
      date: { gte: weekAgo }
    },
    orderBy: { date: 'desc' }
  });

  if (expenses.length === 0) {
    res.json({
      success: true,
      message: 'No expenses to analyze',
      data: { insights: [] }
    });
    return;
  }

  // Calculate summary
  const byCategory: Record<string, number> = {};
  let totalSpent = 0;

  expenses.forEach(expense => {
    totalSpent += expense.amount;
    byCategory[expense.category] = (byCategory[expense.category] || 0) + expense.amount;
  });

  const percentages: Record<string, string> = {};
  Object.keys(byCategory).forEach(category => {
    percentages[category] = ((byCategory[category] / totalSpent) * 100).toFixed(2);
  });

  const topCategories = Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([category]) => category);

  const summary = {
    totalSpent: parseFloat(totalSpent.toFixed(2)),
    currency: req.user!.currency,
    byCategory,
    percentages,
    topCategories
  };

  // Generate insights using AI
  const insightTexts = await generateInsights(expenses, summary);

  // Store insights in database
  const createdInsights = await Promise.all(
    insightTexts.map(async (content) => {
      return await prisma.insight.create({
        data: {
          userId,
          type: 'weekly',
          content,
          metadata: {
            summary,
            expenseCount: expenses.length,
            period: {
              start: weekAgo.toISOString(),
              end: new Date().toISOString()
            }
          },
          period: new Date()
        }
      });
    })
  );

  res.json({
    success: true,
    message: 'Insights generated successfully',
    data: {
      insights: createdInsights,
      summary
    }
  });
});

// @desc    Get user insights
// @route   GET /api/insights
// @access  Private
export const getInsights = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { type, limit = '10' } = req.query;

  // Build cache key
  const cacheKey = `insights:${userId}:${type || 'all'}:${limit}`;
  
  // Check cache
  const cached = await getCache(cacheKey);
  if (cached) {
    res.json({
      success: true,
      data: cached,
      cached: true
    });
    return;
  }

  // Build where clause
  const where: any = { userId };

  // Free tier: monthly insights only
  if (!req.user!.isPremium) {
    where.type = type && type === 'monthly' ? 'monthly' : 'monthly';
  } else if (type) {
    where.type = type;
  }

  // Get insights
  const insights = await prisma.insight.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parseInt(limit as string)
  });

  const result = { insights };

  // Cache for 1 hour
  await setCache(cacheKey, result, 3600);

  res.json({
    success: true,
    data: result
  });
});
