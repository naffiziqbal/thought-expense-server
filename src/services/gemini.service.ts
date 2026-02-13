import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Model configuration from environment variables
const PARSING_MODEL = process.env.PARSING_MODEL || 'gemini-flash-latest';
const INSIGHTS_MODEL = process.env.INSIGHTS_MODEL || 'gemini-flash-latest';

// Fallback models when primary returns 503 / high demand
const PARSING_FALLBACK_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

function isRetryableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /503|429|500|502|504/.test(msg) ||
    /Service Unavailable|high demand|overloaded|rate limit|temporarily/i.test(msg)
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateWithRetryAndFallback<T>(
  models: string[],
  fn: (model: string) => Promise<T>
): Promise<T> {
  const maxRetries = 2;
  let lastError: unknown;

  for (const model of models) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn(model);
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err) || attempt === maxRetries) break;
        const delay = (attempt + 1) * 1500;
        console.warn(`Gemini ${model} attempt ${attempt + 1} failed, retrying in ${delay}ms...`, err);
        await sleep(delay);
      }
    }
    if (models.indexOf(model) < models.length - 1) {
      console.warn(`Switching to fallback model after ${model} failed`);
    }
  }

  throw lastError;
}
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'embedding-001';

// System prompts
const PARSING_SYSTEM_PROMPT = `You are an intelligent expense parsing assistant with access to the user's expense history. Your job is to extract structured expense information from natural language input and suggest the MOST SPECIFIC and ACCURATE category.

RULES:
1. Extract description, amount, category, AND date
2. Handle MULTIPLE expenses in one input - parse ALL of them
3. Be EXTREMELY flexible with input formats:
   - Newlines: "coffee 10\\nbread 20"
   - Commas: "coffee 10, bread 20, rent 30"
   - Spaces only: "coffee 10 bread 20 rent 30"
   - Mixed: "coffee 10, bread 20\\nrent 30"
   - Natural language: "bought coffee for 10 dollars and bread 20"
4. Parse DATES from natural language:
   - "yesterday" → calculate yesterday's date
   - "last week", "3 days ago", "monday" → calculate the date
   - "january 15" → use that date from current year
   - If no date mentioned, use TODAY
5. If currency is mentioned, use it; otherwise use USD
6. Assign confidence score (0-1) based on clarity
7. ALWAYS return an array, even for single expense

CATEGORY ASSIGNMENT - CRITICAL:
You are NOT limited to predefined categories. Suggest SPECIFIC, MEANINGFUL categories based on:
1. USER'S PAST CATEGORIZATIONS (if provided in context)
2. CONTEXT of the expense (business vs personal, location, purpose)
3. SPECIFICITY (prefer "Coffee Shop" over "Food", "Gym Membership" over "Other")

Examples of GOOD specific categories:
- "Coffee Shop" (not just "Food")
- "Business Meals" (for client/work meals)
- "Gym Membership" (not "Other")
- "Children's School" (not just "Education")
- "Office Commute" (not just "Transport")
- "Streaming Services" (not just "Entertainment")
- "Pet Care" (specific category)
- "Home Maintenance" (specific)
- "Professional Development" (not just "Education")

Examples of CONTEXT-AWARE categorization:
- "coffee at starbucks" → "Coffee Shop"
- "coffee at client meeting" → "Business Meals"
- "uber to office" → "Office Commute"
- "uber to airport" → "Travel"
- "netflix subscription" → "Streaming Services"
- "gym membership" → "Gym Membership"

USER'S CATEGORY HISTORY (learn from this):
{{USER_CONTEXT}}

Use the user's past categorizations to maintain CONSISTENCY

OUTPUT FORMAT (JSON array - MUST be array):
[
  {
    "description": "coffee",
    "amount": 10,
    "currency": "USD",
    "category": "Coffee Shop",
    "confidence": 0.95,
    "date": "2024-01-15",
    "rawInput": "coffee 10"
  }
]

CRITICAL: 
- Parse ALL expenses from input
- ALWAYS include date in ISO format (YYYY-MM-DD)
- Today is ${new Date().toISOString().split('T')[0]}
- Be SPECIFIC with categories
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

export interface ParsedCategoryBudget {
  category: string;
  limit: number;
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
    // Build rich context from user's history
    let contextHint = '';
    if (userContext.length > 0) {
      contextHint = '\n\nUSER\'S CATEGORY HISTORY (learn from this):\n';
      userContext.forEach(c => {
        const usage = c.confidence ? Math.round(c.confidence * 10) : 1;
        contextHint += `  - "${c.keyword}" → "${c.category}" (used ${usage}x)\n`;
      });
      contextHint += '\nUse these patterns for CONSISTENCY. If similar expense exists, use same category.';
    } else {
      contextHint = '\n\nNO HISTORY: This is a new user. Suggest specific, meaningful categories.';
    }

    const systemPromptWithContext = PARSING_SYSTEM_PROMPT.replace('{{USER_CONTEXT}}', contextHint);

    const userPrompt = `${systemPromptWithContext}

Default currency: ${userCurrency}
Current date: ${new Date().toISOString().split('T')[0]}

Parse this expense input:
"""
${rawInput}
"""

REMEMBER:
- Suggest SPECIFIC categories (not generic)
- Use user's patterns for consistency
- Return ALL expenses as JSON array

Return JSON array of expenses:`;

    const modelsToTry = [PARSING_MODEL, ...PARSING_FALLBACK_MODELS.filter((m) => m !== PARSING_MODEL)];

    const responseText = await generateWithRetryAndFallback(modelsToTry, async (modelName) => {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(userPrompt);
      return result.response.text();
    });

    // Extract JSON from response
    let jsonText = responseText.trim();
    
    // Remove markdown code blocks
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    // Try to find JSON array
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonText = arrayMatch[0];
    }

    const parsed = JSON.parse(jsonText);
    
    // Ensure it's an array
    const expenses = Array.isArray(parsed) ? parsed : [parsed];

    // Validate and normalize
    return expenses.map(exp => ({
      description: String(exp.description || '').trim(),
      amount: parseFloat(exp.amount) || 0,
      currency: String(exp.currency || userCurrency).toUpperCase(),
      category: String(exp.category || 'Other').trim(),
      confidence: parseFloat(exp.confidence) || 0.5,
      date: exp.date || new Date().toISOString().split('T')[0],
      rawInput: exp.rawInput || rawInput
    }));

  } catch (error: any) {
    console.error('Gemini parsing error:', error);
    if (isRetryableError(error)) {
      throw new Error(
        'Our AI service is temporarily busy. Please try again in a moment.'
      );
    }
    throw new Error(`Failed to parse expenses: ${error.message}`);
  }
};

export const parseCategoryBudgets = async (
  text: string,
  knownCategories: string[] = []
): Promise<ParsedCategoryBudget[]> => {
  try {
    const categoriesHint = knownCategories.length
      ? `Known categories: ${knownCategories.join(', ')}`
      : 'Known categories: Groceries, Health, Medical, Rent, Transport, Entertainment, Utilities, Education, Shopping, Other';

    const prompt = `
You are a budgeting assistant. Extract category-wise budget limits from the user's text.

${categoriesHint}

Input:
"""
${text}
"""

Return ONLY a JSON array like:
[
  { "category": "Groceries", "limit": 4000 },
  { "category": "Health", "limit": 5000 }
]

Rules:
- "category" must be a short, human-readable label (match known categories when possible).
- "limit" is a number (no currency symbol).
- Ignore unrelated text.
`;

    const modelsToTry = [PARSING_MODEL, ...PARSING_FALLBACK_MODELS.filter((m) => m !== PARSING_MODEL)];

    const rawText = await generateWithRetryAndFallback(modelsToTry, async (modelName) => {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    });

    let jsonText = rawText.trim()
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '');

    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonText = arrayMatch[0];

    const parsed = JSON.parse(jsonText);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return items
      .map((i: any) => ({
        category: String(i.category || '').trim(),
        limit: Number(i.limit),
      }))
      .filter((i) => i.category && !isNaN(i.limit) && i.limit > 0);
  } catch (error: any) {
    console.error('parseCategoryBudgets error:', error);
    if (isRetryableError(error)) {
      throw new Error('Our AI is temporarily busy. Please try again in a moment.');
    }
    throw new Error(`Failed to parse category budgets: ${error.message}`);
  }
};

/**
 * Suggest category for a description (for autocomplete/suggestions)
 */
export const suggestCategory = async (
  description: string,
  userContext: UserContext[] = []
): Promise<{ category: string; confidence: number; alternatives?: string[] }> => {
  try {
    let contextHint = '';
    if (userContext.length > 0) {
      contextHint = 'User\'s past patterns:\n';
      userContext.slice(0, 10).forEach(c => {
        contextHint += `- "${c.keyword}" → "${c.category}"\n`;
      });
    }

    const prompt = `You are a category suggestion assistant. Based on the expense description, suggest the MOST SPECIFIC and ACCURATE category.

${contextHint}

Description: "${description}"

Consider context and be specific. Examples:
- "coffee at starbucks" → "Coffee Shop"
- "uber to office" → "Office Commute"
- "gym membership" → "Gym Membership"
- "netflix" → "Streaming Services"

Return JSON:
{
  "category": "Suggested Category",
  "confidence": 0.9,
  "alternatives": ["Alternative 1", "Alternative 2"]
}`;

    const modelsToTry = [PARSING_MODEL, ...PARSING_FALLBACK_MODELS.filter((m) => m !== PARSING_MODEL)];

    const rawText = await generateWithRetryAndFallback(modelsToTry, async (modelName) => {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    });
    let jsonText = rawText.trim();
    
    // Remove markdown
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    const parsed = JSON.parse(jsonText);
    return parsed;

  } catch (error: any) {
    console.error('Category suggestion error:', error);
    return {
      category: 'Other',
      confidence: 0.5,
      alternatives: []
    };
  }
};

/**
 * Generate embedding for text (for RAG)
 * Uses full 3072-dimensional embeddings from gemini-embedding-001
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  try {
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await model.embedContent(text);
    
    // Return full 3072-dimensional embedding (Pinecone now supports this)
    return result.embedding.values;
  } catch (error: any) {
    console.error('Embedding generation error:', error);
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
};

/**
 * Generate insights from expense data
 */
export const generateInsights = async (
  expenses: any[],
  summary: ExpenseSummary
): Promise<string[]> => {
  try {
    if (expenses.length === 0) {
      return ['No expenses to analyze yet. Start tracking to get insights!'];
    }

    const expenseList = expenses.slice(0, 50).map(e => 
      `${e.description} (${e.category}): ${e.amount} ${e.currency}`
    ).join('\n');

    const prompt = `${INSIGHT_SYSTEM_PROMPT}

EXPENSE DATA (last ${expenses.length} transactions):
${expenseList}

SUMMARY:
- Total spent: ${summary.totalSpent} ${summary.currency}
- Top categories: ${summary.topCategories.join(', ')}
- Category breakdown: ${JSON.stringify(summary.byCategory)}

Generate 2-3 helpful, non-judgmental insights about spending patterns.
Focus on trends, comparisons, and interesting observations.

Return as JSON array of strings:
["Insight 1", "Insight 2", "Insight 3"]`;

    const insightFallbacks = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    const modelsToTry = [INSIGHTS_MODEL, ...insightFallbacks.filter((m) => m !== INSIGHTS_MODEL)];

    const rawText = await generateWithRetryAndFallback(modelsToTry, async (modelName) => {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    });
    let jsonText = rawText.trim();
    
    // Remove markdown
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    const insights = JSON.parse(jsonText);
    return Array.isArray(insights) ? insights : [insights];

  } catch (error: any) {
    console.error('Insight generation error:', error);
    return ['Unable to generate insights at this time.'];
  }
};

export { ParsedExpense, UserContext, ExpenseSummary };
