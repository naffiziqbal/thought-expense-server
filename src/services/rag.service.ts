import prisma from '../config/prisma';
import { generateEmbedding } from './gemini.service';
import { upsertExpenseVector, querySimilarExpenses, deleteExpenseVector } from './pinecone.service';

interface UserContextItem {
  keyword: string;
  category: string;
  confidence: number;
}

interface Expense {
  id: string;
  userId: string;
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: Date;
  [key: string]: any;
}

interface SimilarExpense {
  id: string;
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: Date;
  similarity: number;
}

interface CategorySuggestion {
  category: string;
  confidence: number;
}

/**
 * Build user-specific context from past expenses for better classification
 */
export const getUserContext = async (userId: string): Promise<UserContextItem[]> => {
  try {
    // Get user's category mappings (learned from past corrections)
    const mappings = await prisma.categoryMapping.findMany({
      where: { userId },
      orderBy: { confidence: 'desc' },
      take: 50
    });

    return mappings.map(m => ({
      keyword: m.keyword,
      category: m.category,
      confidence: m.confidence
    }));
  } catch (error) {
    console.error('Error fetching user context:', error);
    return [];
  }
};

/**
 * Update user's category mapping when they manually correct a category
 */
export const updateCategoryMapping = async (
  userId: string,
  keyword: string,
  category: string
): Promise<any> => {
  try {
    // Normalize keyword
    const normalizedKeyword = keyword.toLowerCase().trim();

    // Upsert mapping
    const mapping = await prisma.categoryMapping.upsert({
      where: {
        userId_keyword_category: {
          userId,
          keyword: normalizedKeyword,
          category
        }
      },
      update: {
        confidence: 1.0,
        updatedAt: new Date()
      },
      create: {
        userId,
        keyword: normalizedKeyword,
        category,
        confidence: 1.0
      }
    });

    return mapping;
  } catch (error) {
    console.error('Error updating category mapping:', error);
    throw error;
  }
};

/**
 * Store expense embedding in vector database
 */
export const storeExpenseEmbedding = async (expense: Expense): Promise<boolean> => {
  try {
    // Generate embedding from description + category
    const text = `${expense.description} ${expense.category}`;
    const embedding = await generateEmbedding(text);

    // Upsert to Pinecone
    await upsertExpenseVector(expense.id, embedding, {
      userId: expense.userId,
      description: expense.description,
      category: expense.category,
      amount: expense.amount,
      currency: expense.currency
    });

    // Store vector reference in database
    await prisma.vector.create({
      data: {
        expenseId: expense.id,
        vectorId: expense.id,
        metadata: {
          embeddingModel: 'text-embedding-3-small',
          timestamp: new Date().toISOString()
        }
      }
    });

    return true;
  } catch (error) {
    console.error('Error storing expense embedding:', error);
    return false;
  }
};

/**
 * Find similar expenses using RAG
 */
export const findSimilarExpenses = async (
  userId: string,
  description: string,
  limit: number = 5
): Promise<SimilarExpense[]> => {
  try {
    // Generate embedding for query
    const embedding = await generateEmbedding(description);

    // Query Pinecone
    const results = await querySimilarExpenses(embedding, userId, limit);

    // Fetch full expense details from database
    const expenseIds = results.map((r: any) => r.metadata.expenseId);
    
    if (expenseIds.length === 0) return [];

    const expenses = await prisma.expense.findMany({
      where: {
        id: { in: expenseIds },
        userId
      },
      select: {
        id: true,
        description: true,
        amount: true,
        currency: true,
        category: true,
        date: true
      },
      orderBy: { date: 'desc' }
    });

    // Add similarity scores
    return expenses.map(expense => {
      const match = results.find((r: any) => r.metadata.expenseId === expense.id);
      return {
        ...expense,
        similarity: match ? match.score : 0
      };
    });
  } catch (error) {
    console.error('Error finding similar expenses:', error);
    return [];
  }
};

/**
 * Get suggested category based on similar past expenses
 */
export const suggestCategory = async (
  userId: string,
  description: string
): Promise<CategorySuggestion | null> => {
  try {
    const similarExpenses = await findSimilarExpenses(userId, description, 10);
    
    if (similarExpenses.length === 0) return null;

    // Count categories weighted by similarity
    const categoryScores: Record<string, number> = {};
    similarExpenses.forEach(expense => {
      const score = expense.similarity || 0.5;
      categoryScores[expense.category] = (categoryScores[expense.category] || 0) + score;
    });

    // Find category with highest score
    const topCategory = Object.entries(categoryScores)
      .sort(([, a], [, b]) => b - a)[0];

    if (!topCategory) return null;

    const [category, score] = topCategory;
    const totalScore = Object.values(categoryScores).reduce((a, b) => a + b, 0);
    const confidence = score / totalScore;

    return {
      category,
      confidence: Math.min(confidence, 0.95)
    };
  } catch (error) {
    console.error('Error suggesting category:', error);
    return null;
  }
};

/**
 * Delete expense embedding
 */
export const deleteExpenseEmbedding = async (expenseId: string): Promise<boolean> => {
  try {
    await deleteExpenseVector(expenseId);
    
    await prisma.vector.deleteMany({
      where: { expenseId }
    });

    return true;
  } catch (error) {
    console.error('Error deleting expense embedding:', error);
    return false;
  }
};
