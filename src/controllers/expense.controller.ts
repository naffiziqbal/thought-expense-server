import { Response, NextFunction } from 'express';
import multer from 'multer';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { AppError } from '../middleware/error.middleware';
import { parseExpenses, suggestCategory, extractReceiptText } from '../services/gemini.service';
import { getUserContext, storeExpenseEmbedding, updateCategoryMapping, findSimilarExpenses, deleteExpenseEmbedding } from '../services/rag.service';
import { convertAmountsToCurrency } from '../services/exchangeRate.service';
import { setCache, getCache, deleteCache, deleteCachePattern } from '../config/redis';
import { AuthRequest } from '../middleware/auth.middleware';
import { expenseParseQueue } from '../queues/expenseParse.queue';
import { persistParsedExpenses } from '../services/expenseParse.service';
import { detectRecurring } from '../services/recurring.service';
import { checkBudgetAndNotify } from '../services/budgetAlert.service';
import { logger } from '../config/logger';
import { idempotencyKeyFromRequest, withIdempotency } from '../services/idempotency.service';

// @desc    Parse raw text (optionally create)
// @route   POST /api/expenses/parse
// @access  Private
export const parseAndCreateExpenses = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { rawInput, create = true } = req.body;
  const userId = req.user!.id;
  const idempotencyKey = idempotencyKeyFromRequest(req.headers['idempotency-key']);

  const payload = await withIdempotency(
    'expenses-parse',
    userId,
    idempotencyKey,
    async () => {
      const userContext = await getUserContext(userId);
      const parsedExpenses = await parseExpenses(rawInput, req.user!.currency, userContext);

      if (!parsedExpenses || parsedExpenses.length === 0) {
        throw new AppError('Could not parse any expenses from input', 400);
      }

      if (create === false) {
        return {
          httpStatus: 200,
          body: {
            success: true,
            message: `Parsed ${parsedExpenses.length} expense(s)`,
            data: { expenses: parsedExpenses },
          },
        };
      }

      const persisted = await persistParsedExpenses(userId, parsedExpenses, rawInput, req.user!.currency || 'USD');
      return {
        httpStatus: 201,
        body: {
          success: true,
          message: `Successfully parsed ${persisted.expenses.length} expense(s)`,
          data: {
            expenses: persisted.expenses,
            needsReview: persisted.needsReview,
          },
        },
      };
    }
  );

  res.status(payload.httpStatus).json(payload.body);
});

// @desc    Enqueue expense parsing/creation job
// @route   POST /api/expenses/parse/async
// @access  Private
export const enqueueParseAndCreateExpenses = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { rawInput, create = true } = req.body as { rawInput: string; create?: boolean };
  const userId = req.user!.id;
  const idempotencyKey = idempotencyKeyFromRequest(req.headers['idempotency-key']);

  const payload = await withIdempotency(
    'expenses-parse-async',
    userId,
    idempotencyKey,
    async () => {
      const jobId = req.body.clientBatchId
        ? `parse-${userId}-${String(req.body.clientBatchId).slice(0, 80)}`
        : undefined;
      let job;
      try {
        job = await expenseParseQueue.add(
          'parse-expense',
          {
            userId,
            rawInput,
            create: create !== false,
            userCurrency: req.user!.currency || 'USD',
            localPreview: Array.isArray(req.body.localPreview) ? req.body.localPreview : undefined,
            clientBatchId: typeof req.body.clientBatchId === 'string' ? req.body.clientBatchId : undefined,
          },
          jobId ? { jobId } : undefined
        );
      } catch (err) {
        if (jobId) {
          job = await expenseParseQueue.getJob(jobId);
        }
        if (!job) throw err;
      }
      return {
        httpStatus: 202,
        body: {
          success: true,
          message: 'Expense parsing started',
          data: { jobId: job.id },
        },
      };
    }
  );

  res.status(payload.httpStatus).json(payload.body);
});

// @desc    Get parse job status
// @route   GET /api/expenses/parse/jobs/:jobId
// @access  Private
export const getExpenseParseJobStatus = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { jobId } = req.params;
  const userId = req.user!.id;
  const job = await expenseParseQueue.getJob(jobId);

  if (!job) {
    return next(new AppError('Job not found', 404));
  }

  const ownerId = job.data.userId;
  if (ownerId !== userId) {
    return next(new AppError('Not authorized to access this job', 403));
  }

  const state = await job.getState();
  if (state === 'completed') {
    return res.json({
      success: true,
      data: {
        jobId,
        status: 'completed',
        result: job.returnvalue,
      },
    });
  }

  if (state === 'failed') {
    return res.json({
      success: true,
      data: {
        jobId,
        status: 'failed',
        error: job.failedReason || 'Failed to parse expenses',
      },
    });
  }

  const progress = typeof job.progress === 'number' ? job.progress : 0;
  res.json({
    success: true,
    data: {
      jobId,
      status: state,
      progress,
    },
  });
});

// @desc    Create a single expense
// @route   POST /api/expenses
// @access  Private
export const createExpense = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const { description, amount, currency, category, date, rawInput } = req.body;

  if (!description || amount == null) {
    return next(new AppError('Description and amount are required', 400));
  }

  const expense = await prisma.expense.create({
    data: {
      userId,
      description: String(description).trim(),
      amount: parseFloat(amount),
      currency: (currency || req.user!.currency || 'USD').toUpperCase(),
      category: (category || 'Other').trim(),
      confidence: 1.0,
      rawInput: rawInput || `${description} ${amount}`,
      date: date ? new Date(date) : new Date()
    }
  });

  storeExpenseEmbedding(expense).catch(err => {
    logger.error({ err, expenseId: expense.id }, 'Failed to store embedding');
  });

  await deleteCachePattern(`expenses:${userId}:*`);
  await deleteCachePattern(`summary:${userId}:*`);

  void checkBudgetAndNotify(userId);

  const [converted] = await convertAmountsToCurrency([expense], req.user!.currency || 'USD');

  res.status(201).json({
    success: true,
    message: 'Expense created',
    data: { expense: converted }
  });
});

// @desc    Create multiple expenses in one request (used after parse preview)
// @route   POST /api/expenses/batch
// @access  Private
export const createExpensesBatch = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const { expenses } = req.body as {
    expenses: Array<{
      description: string;
      amount: number;
      currency?: string;
      category?: string;
      date?: string;
      rawInput?: string;
    }>;
  };

  if (!Array.isArray(expenses) || expenses.length === 0) {
    return next(new AppError('expenses must be a non-empty array', 400));
  }
  if (expenses.length > 50) {
    return next(new AppError('Cannot create more than 50 expenses at once', 400));
  }
  for (const e of expenses) {
    if (!e.description || e.amount == null || isNaN(parseFloat(String(e.amount)))) {
      return next(new AppError('Each expense needs a description and a numeric amount', 400));
    }
  }

  const created = await withIdempotency(
    'expenses-batch',
    userId,
    idempotencyKeyFromRequest(req.headers['idempotency-key']),
    async () => {
      const rows = await prisma.$transaction(
        expenses.map((e) =>
          prisma.expense.create({
            data: {
              userId,
              description: String(e.description).trim(),
              amount: parseFloat(String(e.amount)),
              currency: (e.currency || req.user!.currency || 'USD').toUpperCase(),
              category: (e.category || 'Other').trim(),
              confidence: 1.0,
              rawInput: e.rawInput || `${e.description} ${e.amount}`,
              date: e.date ? new Date(e.date) : new Date(),
            },
          })
        )
      );

      (async () => {
        for (const expense of rows) {
          await storeExpenseEmbedding(expense).catch((err) => {
            logger.error({ err, expenseId: expense.id }, 'Failed to store embedding');
          });
        }
      })();

      await deleteCachePattern(`expenses:${userId}:*`);
      await deleteCachePattern(`summary:${userId}:*`);

      void checkBudgetAndNotify(userId);

      const converted = await convertAmountsToCurrency(rows, req.user!.currency || 'USD');
      return { expenses: converted };
    }
  );

  res.status(201).json({
    success: true,
    message: `Created ${created.expenses.length} expense(s)`,
    data: { expenses: created.expenses },
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
    logger.info(
      { expenseId: expense.id, from: oldCategory, to: updated.category },
      'Learning category correction'
    );
    
    // Extract keywords from description for learning
    const keywords = expense.description.toLowerCase().split(/\s+/);
    for (const keyword of keywords) {
      if (keyword.length > 2) { // Skip very short words
        updateCategoryMapping(userId, keyword, updated.category).catch(err => {
          logger.error({ err }, 'Failed to update category mapping');
        });
      }
    }
    
    // Also map the full description
    updateCategoryMapping(userId, expense.description, updated.category).catch(err => {
      logger.error({ err }, 'Failed to update category mapping');
    });
  }

  // If description or category changed, update embedding
  if (updates.description || updates.category) {
    storeExpenseEmbedding(updated).catch(err => {
      logger.error({ err, expenseId: updated.id }, 'Failed to update embedding');
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
    logger.error({ err, expenseId: id }, 'Failed to delete embedding');
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

// Multer config for receipt upload (memory storage) - exported for routes
export const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and HEIC images are allowed'));
    }
  },
});

// @desc    OCR a receipt image into raw expense text
// @route   POST /api/expenses/ocr
// @access  Private (Premium)
export const ocrReceipt = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user!.isPremium) {
    return next(new AppError('Receipt scanning is a Premium feature', 403));
  }

  const file = req.file;
  if (!file) {
    return next(new AppError('No image file provided', 400));
  }

  const text = await extractReceiptText(file.buffer.toString('base64'), file.mimetype);
  if (!text) {
    return next(new AppError('Could not read any expenses from the image', 422));
  }

  res.json({
    success: true,
    data: { text },
  });
});

// @desc    Detect recurring expenses (subscriptions, bills)
// @route   GET /api/expenses/recurring
// @access  Private (free tier analyzes its 3-month window with a lower bar)
export const getRecurringExpenses = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const isPremium = req.user!.isPremium;

  const cacheKey = `recurring:${userId}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    res.json({ success: true, data: cached, cached: true });
    return;
  }

  const windowMonths = isPremium ? 12 : 3;
  const since = new Date();
  since.setMonth(since.getMonth() - windowMonths);

  const expenses = await prisma.expense.findMany({
    where: { userId, date: { gte: since } },
    select: { description: true, amount: true, currency: true, category: true, date: true },
    orderBy: { date: 'desc' },
    take: 2000,
  });

  const recurring = detectRecurring(expenses, isPremium ? 3 : 2);
  const data = { recurring, windowMonths };

  await setCache(cacheKey, data, 3600);
  res.json({ success: true, data });
});
