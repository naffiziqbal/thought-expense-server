import { Response } from 'express';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { generateInsights } from '../services/gemini.service';
import { convertAmountsToCurrency } from '../services/exchangeRate.service';
import { setCache, getCache, deleteCachePattern } from '../config/redis';
import { AuthRequest } from '../middleware/auth.middleware';
import { getSpendingIntelligence } from '../services/analytics.service';
import { generateWeeklyBriefingForUser } from '../services/briefing.service';

// @desc    Generate weekly insights
// @route   POST /api/insights/generate
// @access  Private
export const generateWeeklyInsights = asyncHandler(
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;

    // Get expenses from the past week
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const [expenses, previousWeekExpenses] = await Promise.all([
      prisma.expense.findMany({
        where: {
          userId,
          date: { gte: weekAgo },
        },
        orderBy: { date: 'desc' },
      }),
      prisma.expense.findMany({
        where: {
          userId,
          date: { gte: twoWeeksAgo, lt: weekAgo },
        },
        select: { amount: true, currency: true, category: true },
      }),
    ]);

    if (expenses.length === 0) {
      res.json({
        success: true,
        message: 'No expenses to analyze',
        data: { insights: [] },
      });
      return;
    }

    // Convert to user's currency before calculating summary
    const userCurrency = req.user!.currency || 'USD';
    const converted = await convertAmountsToCurrency(expenses, userCurrency);

    // Calculate summary in user's currency
    const byCategory: Record<string, number> = {};
    let totalSpent = 0;

    converted.forEach((expense) => {
      totalSpent += expense.amount;
      byCategory[expense.category] = (byCategory[expense.category] || 0) + expense.amount;
    });

    const percentages: Record<string, string> = {};
    Object.keys(byCategory).forEach((category) => {
      percentages[category] = ((byCategory[category] / totalSpent) * 100).toFixed(2);
    });

    const topCategories = Object.entries(byCategory)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([category]) => category);

    const summary = {
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      currency: userCurrency,
      byCategory,
      percentages,
      topCategories,
    };

    // Previous-week comparison so the AI can explain what changed and why
    let comparisonContext: string | undefined;
    if (previousWeekExpenses.length > 0) {
      const prevConverted = await convertAmountsToCurrency(previousWeekExpenses, userCurrency);
      const prevByCategory: Record<string, number> = {};
      let prevTotal = 0;
      prevConverted.forEach((e) => {
        prevTotal += e.amount;
        prevByCategory[e.category] = (prevByCategory[e.category] || 0) + e.amount;
      });
      comparisonContext = `Previous week total: ${prevTotal.toFixed(2)} ${userCurrency}\nPrevious week by category: ${JSON.stringify(prevByCategory)}`;
    }

    // Generate insights using AI (with converted amounts)
    const insightTexts = await generateInsights(converted, summary, comparisonContext, userId);

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
                end: new Date().toISOString(),
              },
            },
            period: new Date(),
          },
        });
      })
    );

    await deleteCachePattern(`insights:${userId}:*`);

    res.json({
      success: true,
      message: 'Insights generated successfully',
      data: {
        insights: createdInsights,
        summary,
      },
    });
  }
);

// @desc    Spending intelligence: anomalies, trends, waste, recurring, series
// @route   GET /api/insights/intelligence
// @access  Private (free tier analyzes its 3-month window; premium 12 months)
export const getIntelligence = asyncHandler(
  async (req: AuthRequest, res: Response): Promise<void> => {
    const intelligence = await getSpendingIntelligence(
      req.user!.id,
      req.user!.currency || 'USD',
      req.user!.isPremium
    );

    res.json({ success: true, data: intelligence });
  }
);

// @desc    Latest weekly briefing
// @route   GET /api/insights/briefing/latest
// @access  Private
export const getLatestBriefing = asyncHandler(
  async (req: AuthRequest, res: Response): Promise<void> => {
    const briefing = await prisma.insight.findFirst({
      where: { userId: req.user!.id, type: 'briefing' },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: { briefing } });
  }
);

// @desc    Generate this week's briefing on demand (no email; view in app)
// @route   POST /api/insights/briefing/generate
// @access  Private
export const generateBriefingNow = asyncHandler(
  async (req: AuthRequest, res: Response): Promise<void> => {
    const result = await generateWeeklyBriefingForUser(req.user!.id, { sendEmail: false });

    if (!result.generated) {
      res.json({
        success: true,
        message: result.reason || 'Nothing to brief yet',
        data: { briefing: null },
      });
      return;
    }

    const briefing = await prisma.insight.findUnique({ where: { id: result.insightId! } });
    res.json({
      success: true,
      message: 'Briefing generated',
      data: { briefing },
    });
  }
);

// @desc    Get user insights
// @route   GET /api/insights
// @access  Private
export const getInsights = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { type, limit = '10' } = req.query;

  // Build cache key
  const cacheKey = `insights:${userId}:${type || 'all'}:${limit}:${req.user!.isPremium ? 'p' : 'f'}`;

  // Check cache
  const cached = await getCache(cacheKey);
  if (cached) {
    res.json({
      success: true,
      data: cached,
      cached: true,
    });
    return;
  }

  // Build where clause
  const where: any = { userId };
  if (type) {
    where.type = type;
  }

  // Free tier: capped at the 5 most recent insights; premium gets full history
  const requestedLimit = parseInt(limit as string) || 10;
  const take = req.user!.isPremium ? requestedLimit : Math.min(requestedLimit, 5);

  // Get insights
  const insights = await prisma.insight.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
  });

  const result = { insights };

  // Cache for 1 hour
  await setCache(cacheKey, result, 3600);

  res.json({
    success: true,
    data: result,
  });
});
