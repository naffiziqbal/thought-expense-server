import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { AppError } from '../middleware/error.middleware';
import { parseExpenses, suggestCategory } from '../services/gemini.service';
import { getUserContext, storeExpenseEmbedding, updateCategoryMapping, findSimilarExpenses, deleteExpenseEmbedding } from '../services/rag.service';
import { convertAmountsToCurrency } from '../services/exchangeRate.service';
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
  await deleteCachePattern(`summary:${userId}:*`);

  // Convert to user's currency for response
  const convertedExpenses = await convertAmountsToCurrency(createdExpenses, req.user!.currency || 'USD');

  // Flag low-confidence expenses
  const needsReview = createdExpenses.filter(
    e => e.confidence < parseFloat(process.env.CLASSIFICATION_CONFIDENCE_THRESHOLD || '0.7')
  );

  res.status(201).json({
    success: true,
    message: `Successfully parsed ${createdExpenses.length} expense(s)`,
    data: {
      expenses: convertedExpenses,
      needsReview: needsReview.length > 0 ? needsReview.map(e => e.id) : []
    }
  });
});

// @desc    Get user expenses with filters
// @route   GET /api/expenses
// @access  Private
export const getExpenses = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const userCurrency = req.user!.currency || 'USD';
  const { startDate, endDate, category, limit = '50', offset = '0' } = req.query;

  // Build cache key (include user currency - converted data differs per currency)
  const cacheKey = `expenses:${userId}:${userCurrency}:${startDate || 'all'}:${endDate || 'all'}:${category || 'all'}:${limit}:${offset}`;
  
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

  // Free tier: limit to past 3 months; Premium: no date limit unless filtered
  if (!req.user!.isPremium) {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    where.date = {
      gte: startDate
        ? new Date(Math.max(new Date(startDate as string).getTime(), threeMonthsAgo.getTime()))
        : threeMonthsAgo,
      ...(endDate && { lte: new Date(endDate as string) }),
    };
  } else if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate as string);
    if (endDate) where.date.lte = new Date(endDate as string);
  }

  if (category) {
    where.category = category;
  }

  const limitNum = parseInt(limit as string) || 10;
  const offsetNum = parseInt(offset as string) || 0;

  // Get expenses
  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { date: 'desc' },
      take: limitNum,
      skip: offsetNum
    }),
    prisma.expense.count({ where })
  ]);

  const page = Math.floor(offsetNum / limitNum) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limitNum));

  // Convert amounts to user's currency
  const convertedExpenses = await convertAmountsToCurrency(expenses, userCurrency);

  const result = {
    expenses: convertedExpenses,
    pagination: {
      total,
      limit: limitNum,
      offset: offsetNum,
      page,
      totalPages,
      hasMore: offsetNum + expenses.length < total
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

  // Convert to user's currency
  const [converted] = await convertAmountsToCurrency([expense], req.user!.currency || 'USD');

  res.json({
    success: true,
    data: { expense: converted }
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
  await deleteCachePattern(`summary:${userId}:*`);

  // Convert to user's currency for response
  const [converted] = await convertAmountsToCurrency([updated], req.user!.currency || 'USD');

  res.json({
    success: true,
    message: 'Expense updated successfully',
    data: { expense: converted }
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
  await deleteCachePattern(`summary:${userId}:*`);

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
  const userCurrency = req.user!.currency || 'USD';
  const { startDate, endDate } = req.query;

  // Build cache key (include user currency)
  const cacheKey = `summary:${userId}:${userCurrency}:${startDate || 'all'}:${endDate || 'all'}`;
  
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

  // Free tier: limit to past 3 months
  if (!req.user!.isPremium) {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    where.date = { gte: threeMonthsAgo };
    if (startDate) {
      const from = new Date(startDate as string);
      where.date.gte = from > threeMonthsAgo ? from : threeMonthsAgo;
    }
    if (endDate) where.date.lte = new Date(endDate as string);
  } else if (startDate || endDate) {
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
        currency: userCurrency,
        byCategory: {},
        percentages: {},
        topCategories: [],
        transactionCount: 0
      }
    });
    return;
  }

  // Convert all amounts to user's currency before summing
  const converted = await convertAmountsToCurrency(expenses, userCurrency);

  // Calculate totals by category (in user's currency)
  const byCategory: Record<string, number> = {};
  let totalSpent = 0;

  converted.forEach(expense => {
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
    currency: userCurrency,
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

  // Convert to user's currency
  const converted = await convertAmountsToCurrency(filtered, req.user!.currency || 'USD');

  res.json({
    success: true,
    data: {
      similar: converted
    }
  });
});

// @desc    Export expenses as CSV or PDF (Premium only)
// @route   GET /api/expenses/export
// @access  Private (Premium)
export const exportExpenses = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;

  if (!req.user!.isPremium) {
    return next(new AppError('Export is available for Premium users only', 403));
  }

  const { format, from, to } = req.query;
  if (!format || (format !== 'csv' && format !== 'pdf')) {
    return next(new AppError('Format must be csv or pdf', 400));
  }

  const startDate = from ? new Date(from as string) : new Date(0);
  const endDate = to ? new Date(to as string) : new Date();

  const expenses = await prisma.expense.findMany({
    where: {
      userId,
      date: { gte: startDate, lte: endDate },
    },
    orderBy: { date: 'desc' },
  });

  // Convert to user's currency
  const userCurrency = req.user!.currency || 'USD';
  const convertedExpenses = await convertAmountsToCurrency(expenses, userCurrency);

  const dateStr = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const totalAmount = convertedExpenses.reduce((sum, e) => sum + e.amount, 0);
    const header = 'Date,Description,Category,Amount,Currency\n';
    const rows = convertedExpenses
      .map(
        (e) =>
          `${e.date.toISOString().slice(0, 10)},"${(e.description || '').replace(/"/g, '""')}",${e.category},${e.amount},${e.currency}`
      )
      .join('\n');
    const totalRow = `\n"Total Expense","","",${totalAmount.toFixed(2)},${userCurrency}`;
    const csv = header + rows + totalRow;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${dateStr}.csv"`);
    res.send(csv);
    return;
  }

  // PDF - simple text-based using built-in (expenses already converted)
  const { createPdf } = await import('../utils/pdfExport');
  const pdfBuffer = await createPdf(convertedExpenses, userCurrency, dateStr);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${dateStr}.pdf"`);
  res.send(pdfBuffer);
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
