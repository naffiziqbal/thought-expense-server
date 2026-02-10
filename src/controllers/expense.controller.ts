import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { AppError } from '../middleware/error.middleware';
import { parseExpenses, suggestCategory } from '../services/gemini.service';
import { getUserContext, storeExpenseEmbedding, updateCategoryMapping, findSimilarExpenses, deleteExpenseEmbedding } from '../services/rag.service';
import { setCache, getCache, deleteCache, deleteCachePattern } from '../config/redis';
import { AuthRequest } from '../middleware/auth.middleware';

// @desc    Parse raw text and create expenses
// @route   POST /api/expenses/parse
// @access  Private
export const parseAndCreateExpenses = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { rawInput } = req.body;
  const userId = req.user!.id;

  // Get user context for better classification
  const userContext = await getUserContext(userId);

  // Parse expenses using AI
  const parsedExpenses = await parseExpenses(rawInput, req.user!.currency, userContext);

  if (!parsedExpenses || parsedExpenses.length === 0) {
    return next(new AppError('Could not parse any expenses from input', 400));
  }

  // Create expenses in database
  const createdExpenses = await Promise.all(
    parsedExpenses.map(async (expense) => {
      const created = await prisma.expense.create({
        data: {
          userId,
          description: expense.description,
          amount: expense.amount,
          currency: expense.currency,
          category: expense.category,
          confidence: expense.confidence,
          rawInput: expense.rawInput || rawInput,
          date: new Date(expense.date)
        }
      });

      // Store embedding asynchronously (don't wait)
      storeExpenseEmbedding(created).catch(err => {
        console.error('Failed to store embedding:', err);
      });

      return created;
    })
  );

  // Invalidate cache
  await deleteCachePattern(`expenses:${userId}:*`);
  await deleteCache(`summary:${userId}`);

  // Flag low-confidence expenses
  const needsReview = createdExpenses.filter(
    e => e.confidence < parseFloat(process.env.CLASSIFICATION_CONFIDENCE_THRESHOLD || '0.7')
  );

  res.status(201).json({
    success: true,
    message: `Successfully parsed ${createdExpenses.length} expense(s)`,
    data: {
      expenses: createdExpenses,
      needsReview: needsReview.length > 0 ? needsReview.map(e => e.id) : []
    }
  });
});

// @desc    Get user expenses with filters
// @route   GET /api/expenses
// @access  Private
export const getExpenses = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { startDate, endDate, category, limit = '50', offset = '0' } = req.query;

  // Build cache key
  const cacheKey = `expenses:${userId}:${startDate || 'all'}:${endDate || 'all'}:${category || 'all'}:${limit}:${offset}`;
  
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
  
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate as string);
    if (endDate) where.date.lte = new Date(endDate as string);
  }
  
  if (category) {
    where.category = category;
  }

  // Get expenses
  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { date: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string)
    }),
    prisma.expense.count({ where })
  ]);

  const result = {
    expenses,
    pagination: {
      total,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      hasMore: total > parseInt(offset as string) + parseInt(limit as string)
    }
  };

  // Cache for 5 minutes
  await setCache(cacheKey, result, 300);

  res.json({
    success: true,
    data: result
  });
});

// @desc    Get single expense by ID
// @route   GET /api/expenses/:id
// @access  Private
export const getExpenseById = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const expense = await prisma.expense.findFirst({
    where: { id, userId }
  });

  if (!expense) {
    return next(new AppError('Expense not found', 404));
  }

  res.json({
    success: true,
    data: { expense }
  });
});

// @desc    Update expense
// @route   PATCH /api/expenses/:id
// @access  Private
export const updateExpense = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const updates = req.body;

  // Check if expense exists and belongs to user
  const expense = await prisma.expense.findFirst({
    where: { id, userId }
  });

  if (!expense) {
    return next(new AppError('Expense not found', 404));
  }

  // If category is being updated, learn from this correction
  if (updates.category && updates.category !== expense.category) {
    await updateCategoryMapping(userId, expense.description, updates.category);
    
    // Update confidence to 1.0 since user manually corrected
    updates.confidence = 1.0;
  }

  // Check if category was manually changed (for RAG learning)
  const categoryChanged = updates.category && expense.category !== updates.category;
  const oldCategory = expense.category;

  // Update expense
  const updated = await prisma.expense.update({
    where: { id },
    data: {
      ...updates,
      updatedAt: new Date(),
      // If category manually changed, set confidence to 1.0 (user correction)
      confidence: categoryChanged ? 1.0 : expense.confidence
    }
  });

  // If category was manually changed, teach RAG system
  if (categoryChanged) {
    console.log(`Learning: "${expense.description}" changed from "${oldCategory}" → "${updated.category}"`);
    
    // Extract keywords from description for learning
    const keywords = expense.description.toLowerCase().split(/\s+/);
    for (const keyword of keywords) {
      if (keyword.length > 2) { // Skip very short words
        updateCategoryMapping(userId, keyword, updated.category).catch(err => {
          console.error('Failed to update category mapping:', err);
        });
      }
    }
    
    // Also map the full description
    updateCategoryMapping(userId, expense.description, updated.category).catch(err => {
      console.error('Failed to update category mapping:', err);
    });
  }

  // If description or category changed, update embedding
  if (updates.description || updates.category) {
    storeExpenseEmbedding(updated).catch(err => {
      console.error('Failed to update embedding:', err);
    });
  }

  // Invalidate cache
  await deleteCachePattern(`expenses:${userId}:*`);
  await deleteCache(`summary:${userId}`);

  res.json({
    success: true,
    message: 'Expense updated successfully',
    data: { expense: updated }
  });
});

// @desc    Delete expense
// @route   DELETE /api/expenses/:id
// @access  Private
export const deleteExpense = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const userId = req.user!.id;

  // Check if expense exists and belongs to user
  const expense = await prisma.expense.findFirst({
    where: { id, userId }
  });

  if (!expense) {
    return next(new AppError('Expense not found', 404));
  }

  // Delete expense (cascade will delete vector)
  await prisma.expense.delete({
    where: { id }
  });

  // Delete from Pinecone
  deleteExpenseEmbedding(id).catch(err => {
    console.error('Failed to delete embedding:', err);
  });

  // Invalidate cache
  await deleteCachePattern(`expenses:${userId}:*`);
  await deleteCache(`summary:${userId}`);

  res.json({
    success: true,
    message: 'Expense deleted successfully'
  });
});

// @desc    Get category summary
// @route   GET /api/expenses/summary
// @access  Private
export const getCategorySummary = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { startDate, endDate } = req.query;

  // Build cache key
  const cacheKey = `summary:${userId}:${startDate || 'all'}:${endDate || 'all'}`;
  
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
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate as string);
    if (endDate) where.date.lte = new Date(endDate as string);
  }

  // Get all expenses in period
  const expenses = await prisma.expense.findMany({
    where,
    select: {
      amount: true,
      currency: true,
      category: true
    }
  });

  if (expenses.length === 0) {
    res.json({
      success: true,
      data: {
        totalSpent: 0,
        currency: req.user!.currency,
        byCategory: {},
        percentages: {},
        topCategories: [],
        transactionCount: 0
      }
    });
    return;
  }

  // Calculate totals by category
  const byCategory: Record<string, number> = {};
  let totalSpent = 0;

  expenses.forEach(expense => {
    const amount = expense.amount;
    totalSpent += amount;
    byCategory[expense.category] = (byCategory[expense.category] || 0) + amount;
  });

  // Calculate percentages
  const percentages: Record<string, string> = {};
  Object.keys(byCategory).forEach(category => {
    percentages[category] = ((byCategory[category] / totalSpent) * 100).toFixed(2);
  });

  // Get top 3 categories
  const topCategories = Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([category]) => category);

  const summary = {
    totalSpent: parseFloat(totalSpent.toFixed(2)),
    currency: req.user!.currency,
    byCategory,
    percentages,
    topCategories,
    transactionCount: expenses.length
  };

  // Cache for 10 minutes
  await setCache(cacheKey, summary, 600);

  res.json({
    success: true,
    data: summary
  });
});

// @desc    Get similar expenses (RAG)
// @route   GET /api/expenses/:id/similar
// @access  Private
export const getSimilarExpenses = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const userId = req.user!.id;

  // Get expense
  const expense = await prisma.expense.findFirst({
    where: { id, userId }
  });

  if (!expense) {
    return next(new AppError('Expense not found', 404));
  }

  // Find similar expenses
  const similar = await findSimilarExpenses(userId, expense.description, 5);

  // Filter out the expense itself
  const filtered = similar.filter(e => e.id !== id);

  res.json({
    success: true,
    data: {
      similar: filtered
    }
  });
});

// @desc    Suggest category for description (RAG + AI)
// @route   GET /api/expenses/suggest-category
// @access  Private
export const suggestCategoryForDescription = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { description } = req.query;
  const userId = req.user!.id;

  if (!description || typeof description !== 'string') {
    return next(new AppError('Description is required', 400));
  }

  // Get user's category history for context
  const userContext = await getUserContext(userId);

  // Get AI suggestion
  const suggestion = await suggestCategory(description, userContext);

  res.json({
    success: true,
    data: {
      suggestedCategories: [
        {
          category: suggestion.category,
          confidence: suggestion.confidence,
          reason: 'Based on your spending patterns and expense context'
        },
        ...(suggestion.alternatives || []).map((alt: string) => ({
          category: alt,
          confidence: 0.7,
          reason: 'Alternative suggestion'
        }))
      ]
    }
  });
});
