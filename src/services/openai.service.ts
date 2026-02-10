import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// System prompts
const PARSING_SYSTEM_PROMPT = `You are an expense parsing assistant. Your job is to extract structured expense information from natural language input.

RULES:
1. Extract description, amount, and infer category
2. Multiple expenses can be in one input
3. If currency is mentioned, use it; otherwise use USD
4. Be flexible with formats
5. Assign confidence score (0-1) based on clarity

CATEGORIES (choose one):
- Food (groceries, restaurants, dining)
- Transport (uber, taxi, fare, gas, parking)
- Rent (rent, housing)
- Utilities (electricity, water, internet, phone)
- Shopping (clothes, electronics, general shopping)
- Entertainment (movies, games, subscriptions)
- Healthcare (doctor, medicine, hospital)
- Education (courses, books, tuition)
- Personal Care (makeup, salon, grooming)
- Fees (bank fees, service charges)
- Other (anything else)

OUTPUT FORMAT (JSON array):
[
  {
    "description": "banana",
    "amount": 10,
    "currency": "USD",
    "category": "Food",
    "confidence": 0.9,
    "rawInput": "brought 10 banana for 10 dollars"
  }
]

Be precise. Return ONLY valid JSON array.`;

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
 * Parse natural language expenses into structured data
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

    const userPrompt = `Default currency: ${userCurrency}${contextHint}

Parse this expense input:
"""
${rawInput}
"""

Return JSON array of expenses.`;

    const response = await openai.chat.completions.create({
      model: process.env.PARSING_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: PARSING_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0].message.content;
    
    if (!content) {
      throw new Error('No content returned from OpenAI');
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
      console.error('Failed to parse OpenAI response:', content);
      throw new Error('Invalid response format from AI');
    }

    // Validate and sanitize each expense
    const validatedExpenses: ParsedExpense[] = parsed.map((expense: any) => ({
      description: expense.description || 'Unknown',
      amount: parseFloat(expense.amount) || 0,
      currency: expense.currency || userCurrency,
      category: expense.category || 'Other',
      confidence: parseFloat(expense.confidence) || 0.5,
      rawInput: expense.rawInput || rawInput
    }));

    return validatedExpenses;
  } catch (error: any) {
    console.error('OpenAI parsing error:', error);
    throw new Error(`Failed to parse expenses: ${error.message}`);
  }
};

/**
 * Generate insights from expense data
 */
export const generateInsights = async (
  expenses: any[],
  summary: ExpenseSummary,
  period: string = 'week'
): Promise<string[]> => {
  try {
    const userPrompt = `Analyze these expenses for the past ${period}:

TOTAL SPENT: ${summary.totalSpent} ${summary.currency}

CATEGORY BREAKDOWN:
${Object.entries(summary.byCategory)
  .map(([cat, amt]) => `- ${cat}: ${amt} ${summary.currency} (${summary.percentages[cat]}%)`)
  .join('\n')}

TOP CATEGORIES: ${summary.topCategories.join(', ')}
TRANSACTION COUNT: ${expenses.length}

Generate 2-3 brief, helpful insights about spending patterns.`;

    const response = await openai.chat.completions.create({
      model: process.env.INSIGHTS_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: INSIGHT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 300
    });

    const content = response.choices[0].message.content;
    
    if (!content) {
      throw new Error('No content returned from OpenAI');
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
    console.error('OpenAI insights error:', error);
    throw new Error(`Failed to generate insights: ${error.message}`);
  }
};

/**
 * Generate embeddings for expense description (for RAG)
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
      encoding_format: 'float'
    });

    return response.data[0].embedding;
  } catch (error: any) {
    console.error('OpenAI embedding error:', error);
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
};
