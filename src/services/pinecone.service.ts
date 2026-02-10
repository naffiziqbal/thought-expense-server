import { Pinecone, Index } from '@pinecone-database/pinecone';

let pinecone: Pinecone | null = null;
let index: Index | null = null;

interface VectorMetadata {
  userId?: string;
  expenseId?: string;
  description?: string;
  category?: string;
  amount?: number;
  currency?: string;
  timestamp?: string;
  [key: string]: any;
}

/**
 * Initialize Pinecone client
 */
export const initPinecone = async (): Promise<Pinecone> => {
  if (pinecone) return pinecone;

  try {
    pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY!
    });

    const indexName = process.env.PINECONE_INDEX_NAME || 'thoughtexpense-embeddings';
    index = pinecone.index(indexName);

    console.log('✅ Pinecone initialized');
    return pinecone;
  } catch (error) {
    console.error('❌ Pinecone initialization failed:', error);
    throw error;
  }
};

/**
 * Get Pinecone index
 */
export const getIndex = (): Index => {
  if (!index) {
    throw new Error('Pinecone not initialized. Call initPinecone first.');
  }
  return index;
};

/**
 * Upsert expense vector to Pinecone
 */
export const upsertExpenseVector = async (
  expenseId: string,
  embedding: number[],
  metadata: VectorMetadata = {}
): Promise<boolean> => {
  try {
    const idx = getIndex();
    
    await idx.upsert([
      {
        id: expenseId,
        values: embedding,
        metadata: {
          ...metadata,
          expenseId,
          timestamp: new Date().toISOString()
        }
      }
    ]);

    return true;
  } catch (error) {
    console.error('Pinecone upsert error:', error);
    throw error;
  }
};

/**
 * Query similar expenses by embedding
 */
export const querySimilarExpenses = async (
  embedding: number[],
  userId: string,
  topK: number = 5
): Promise<any[]> => {
  try {
    const idx = getIndex();
    
    const results = await idx.query({
      vector: embedding,
      topK,
      filter: { userId },
      includeMetadata: true
    });

    return results.matches || [];
  } catch (error) {
    console.error('Pinecone query error:', error);
    throw error;
  }
};

/**
 * Delete expense vector from Pinecone
 */
export const deleteExpenseVector = async (expenseId: string): Promise<boolean> => {
  try {
    const idx = getIndex();
    await idx.deleteOne(expenseId);
    return true;
  } catch (error) {
    console.error('Pinecone delete error:', error);
    throw error;
  }
};

/**
 * Delete all vectors for a user
 */
export const deleteUserVectors = async (userId: string): Promise<boolean> => {
  try {
    const idx = getIndex();
    await idx.deleteMany({ userId });
    return true;
  } catch (error) {
    console.error('Pinecone delete user vectors error:', error);
    throw error;
  }
};
