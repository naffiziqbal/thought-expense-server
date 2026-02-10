import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// System prompts
const PARSING_SYSTEM_PROMPT = `You are an expense parsing assistant. Your job is to extract structured expense information from natural language input.

RULES:
1. Extract description, amount, category, AND date
2. Handle MULTIPLE expenses in one input - parse ALL of them
3. Be EXTREMELY flexible with input formats:
   - Newlines: "coffee 10\nbread 20"
   - Commas: "coffee 10, bread 20, rent 30"
   - Spaces only: "coffee 10 bread 20 rent 30"
   - Mixed: "coffee 10, bread 20\nrent 30"
   - Natural language: "bought coffee for 10 dollars and bread 20"
4. Parse DATES from natural language:
   - "yesterday" → calculate yesterday's date
   - "last week", "3 days ago", "monday" → calculate the date
   - "january 15" → use that date from current year
   - If no date mentioned, use TODAY
5. If currency is mentioned, use it; otherwise use USD
6. Assign confidence score (0-1) based on clarity
7. ALWAYS return an array, even for single expense

CATEGORIES (choose one):
- Food (groceries, restaurants, dining, coffee, bread, meals)
- Transport (uber, taxi, fare, gas, parking)
- Rent (rent, housing, apartment)
- Utilities (electricity, water, internet, phone, bills)
- Shopping (clothes, electronics, general shopping)
- Entertainment (movies, games, subscriptions)
- Healthcare (doctor, medicine, hospital)
- Education (courses, books, tuition)
- Personal Care (makeup, salon, grooming)
- Fees (bank fees, service charges)
- Other (anything else)

OUTPUT FORMAT (JSON array - MUST be array):
[
  {
    "description": "coffee",
    "amount": 10,
    "currency": "USD",
    "category": "Food",
    "confidence": 0.95,
    "date": "2024-01-15",
    "rawInput": "coffee 10"
  },
  {
    "description": "mac mini",
    "amount": 599,
    "currency": "USD",
    "category": "Shopping",
    "confidence": 0.9,
    "date": "2024-01-14",
    "rawInput": "bought a mac mini yesterday"
  }
]

CRITICAL: 
- Parse ALL expenses from input. If "coffee 10 bread 20 rent 30", return 3 expense objects.
- ALWAYS include date in ISO format (YYYY-MM-DD)
- Calculate relative dates correctly (yesterday, last week, etc.)
- Today is ${new Date().toISOString().split('T')[0]}
Be precise. Return ONLY valid JSON array with ALL expenses found.`;

const INSIGHT_SYSTEM_PROMPT = `You are a financial insights assistant. Analyze expense data and provide helpful, non-judgmental observations.

RULES:
1. Be informational, not prescriptive
2. Focus on patterns and trends
3. Keep insights short and actionable
4. Maximum 3 insights per analysis
5. Use percentages and comparisons
6. No "you should" language

TONE: Friendly, factual, helpful`;

interface ParsedExpense {
  description: string;
  amount: number;
  currency: string;
  category: string;
  confidence: number;
  date: string;
  rawInput: string;
}

interface UserContext {
  keyword: string;
  category: string;
  confidence?: number;
}

interface ExpenseSummary {
  totalSpent: number;
  currency: string;
  byCategory: Record<string, number>;
  percentages: Record<string, string>;
  topCategories: string[];
}

/**
 * Parse natural language expenses into structured data using Gemini
 */
export const parseExpenses = async (
  rawInput: string,
  userCurrency: string = 'USD',
  userContext: UserContext[] = []
): Promise<ParsedExpense[]> => {
  try {
    const contextHint = userContext.length > 0 
      ? `\n\nUSER CONTEXT (past patterns):\n${userContext.map(c => `"${c.keyword}" → ${c.category}`).join('\n')}`
      : '';

    const userPrompt = `${PARSING_SYSTEM_PROMPT}

Default currency: ${userCurrency}${contextHint}

Parse this expense input:
"""
${rawInput}
"""

Return JSON array of expenses.`;

    // Use Gemini model
    const model = genAI.getGenerativeModel({ 
      model: process.env.PARSING_MODEL || 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json'
      }
    });

    const result = await model.generateContent(userPrompt);
    const response = result.response;
    const content = response.text();
    
    if (!content) {
      throw new Error('No content returned from Gemini');
    }
    
    // Parse the JSON response
    let parsed: any;
    try {
      parsed = JSON.parse(content);
      // If the response is wrapped in an object with an array property, extract it
      if (parsed.expenses && Array.isArray(parsed.expenses)) {
        parsed = parsed.expenses;
      } else if (!Array.isArray(parsed)) {
        // If it's a single object, wrap it in an array
        parsed = [parsed];
      }
    } catch (e) {
      console.error('Failed to parse Gemini response:', content);
      throw new Error('Invalid response format from AI');
    }

    // Validate and sanitize each expense
    const validatedExpenses: ParsedExpense[] = parsed.map((expense: any) => ({
      description: expense.description || 'Unknown',
      amount: parseFloat(expense.amount) || 0,
      currency: expense.currency || userCurrency,
      category: expense.category || 'Other',
      confidence: parseFloat(expense.confidence) || 0.5,
      date: expense.date || new Date().toISOString().split('T')[0],
      rawInput: expense.rawInput || rawInput
    }));

    return validatedExpenses;
  } catch (error: any) {
    console.error('Gemini parsing error:', error);
    throw new Error(`Failed to parse expenses: ${error.message}`);
  }
};

/**
 * Generate insights from expense data using Gemini
 */
export const generateInsights = async (
  expenses: any[],
  summary: ExpenseSummary,
  period: string = 'week'
): Promise<string[]> => {
  try {
    const userPrompt = `${INSIGHT_SYSTEM_PROMPT}

Analyze these expenses for the past ${period}:

TOTAL SPENT: ${summary.totalSpent} ${summary.currency}

CATEGORY BREAKDOWN:
${Object.entries(summary.byCategory)
  .map(([cat, amt]) => `- ${cat}: ${amt} ${summary.currency} (${summary.percentages[cat]}%)`)
  .join('\n')}

TOP CATEGORIES: ${summary.topCategories.join(', ')}
TRANSACTION COUNT: ${expenses.length}

Generate 2-3 brief, helpful insights about spending patterns.`;

    const model = genAI.getGenerativeModel({ 
      model: process.env.INSIGHTS_MODEL || 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 300
      }
    });

    const result = await model.generateContent(userPrompt);
    const response = result.response;
    const content = response.text();
    
    if (!content) {
      throw new Error('No content returned from Gemini');
    }
    
    // Split into individual insights
    const insights = content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => line.replace(/^[\d\-\*\•]\s*/, '').trim())
      .filter(line => line.length > 10)
      .slice(0, 3);

    return insights;
  } catch (error: any) {
    console.error('Gemini insights error:', error);
    throw new Error(`Failed to generate insights: ${error.message}`);
  }
};

/**
 * Generate embeddings for expense description (for RAG) using Gemini
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  try {
    // Use Gemini's embedding model with configurable dimensions
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-embedding-001'
    });

    const result = await model.embedContent(text);
    
    const embedding = result.embedding;
    
    if (!embedding || !embedding.values) {
      throw new Error('No embedding returned from Gemini');
    }

    // Return first 1024 dimensions to match Pinecone index
    return embedding.values.slice(0, 1024);
  } catch (error: any) {
    console.error('Gemini embedding error:', error);
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
};
