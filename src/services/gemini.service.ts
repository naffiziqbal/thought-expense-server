import { GoogleGenerativeAI, GenerativeModel, type ModelParams } from '@google/generative-ai';
import { findCategoryFromCatalog } from './categoryCatalog.service';
import { logger } from '../config/logger';
import { costNanoUsd, normalizeModelName } from '../config/aiPricing';
import { normalizeDigits, parseAmount } from '../utils/digits.util';
import { EMBEDDING_DIMENSIONS, isValidEmbedding } from './pinecone.service';
import {
  recordAiCacheHit,
  recordAiFallback,
  recordAiUsage,
  recordUserAiUsage,
  type AiMetricKind,
} from './aiMetrics.service';
import {
  aiResponseCacheEnabled,
  aiResponseCacheKey,
  getCachedAiResponse,
  setCachedAiResponse,
  type AiContents,
} from './aiCache.service';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Optional backup key used when the primary key is rate-limited or failing.
const backupAI = process.env.GEMINI_API_KEY_BACKUP
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY_BACKUP)
  : null;

const modelList = (raw: string | undefined, fallback: string): string[] =>
  (raw || fallback)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

// `-latest` aliases never retire (Google repoints them), so they make the safest primary.
const PARSING_MODEL = process.env.PARSING_MODEL || 'gemini-flash-latest';
const INSIGHTS_MODEL = process.env.INSIGHTS_MODEL || 'gemini-flash-latest';

// Tried in order when the primary model fails (503 / overloaded). Pick models with their
// own capacity: some names are aliases of each other (3.7-flash is deprecated and redirected to 3.8-flash),
// and falling back to an alias of the primary achieves nothing. The ops monitor alerts
// when any of these is retired.
const FALLBACK_MODELS = modelList(
  process.env.GEMINI_FALLBACK_MODELS || process.env.PARSING_FALLBACK_MODELS,
  'gemini-3.6-flash,gemini-flash-lite-latest'
);

const BACKUP_MODELS = modelList(
  process.env.GEMINI_BACKUP_MODELS,
  'gemini-flash-latest,gemini-flash-lite-latest'
);

export interface ConfiguredModel {
  label: 'primary' | 'backup';
  model: string;
  /** Env var(s) that put it there, or "default" — so an alert can say exactly what to change. */
  sources: string[];
}

/** Every model this service may call, per key — used by the ops monitor's retirement check. */
export function configuredGeminiModels(): ConfiguredModel[] {
  const fallbackVar = process.env.GEMINI_FALLBACK_MODELS
    ? 'GEMINI_FALLBACK_MODELS'
    : process.env.PARSING_FALLBACK_MODELS
      ? 'PARSING_FALLBACK_MODELS'
      : 'default fallbacks';
  const entries: Array<[ConfiguredModel['label'], string, string]> = [
    [
      'primary',
      PARSING_MODEL,
      process.env.PARSING_MODEL ? 'PARSING_MODEL' : 'default PARSING_MODEL',
    ],
    [
      'primary',
      INSIGHTS_MODEL,
      process.env.INSIGHTS_MODEL ? 'INSIGHTS_MODEL' : 'default INSIGHTS_MODEL',
    ],
    ...FALLBACK_MODELS.map((m): [ConfiguredModel['label'], string, string] => [
      'primary',
      m,
      fallbackVar,
    ]),
    ...(backupAI
      ? BACKUP_MODELS.map((m): [ConfiguredModel['label'], string, string] => [
          'backup',
          m,
          process.env.GEMINI_BACKUP_MODELS ? 'GEMINI_BACKUP_MODELS' : 'default backup models',
        ])
      : []),
  ];

  const merged = new Map<string, ConfiguredModel>();
  for (const [label, model, source] of entries) {
    const key = `${label}/${model}`;
    const existing = merged.get(key);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      merged.set(key, { label, model, sources: [source] });
    }
  }
  return [...merged.values()];
}

/**
 * Check each configured model with countTokens — free, and unlike models.get it
 * returns 404 for retired models.
 */
export async function probeGeminiModels(): Promise<
  Array<ConfiguredModel & { ok: boolean; error?: string }>
> {
  return Promise.all(
    configuredGeminiModels().map(async (entry) => {
      const client = entry.label === 'primary' ? genAI : backupAI!;
      try {
        await client.getGenerativeModel({ model: entry.model }).countTokens('ping');
        return { ...entry, ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Only a missing model is a config problem; rate limits etc. are someone else's alert.
        return isModelGoneError(err)
          ? { ...entry, ok: false, error: message.slice(0, 160) }
          : { ...entry, ok: true };
      }
    })
  );
}

export function isRetryableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /503|429|500|502|504/.test(msg) ||
    /Service Unavailable|high demand|overloaded|rate limit|temporarily/i.test(msg)
  );
}

/** Model retired or misspelled — retrying or waiting won't help. */
export function isModelGoneError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /\[404|NOT_FOUND|no longer available|is not found for API version/i.test(msg);
}

/** `label/model` → retry after (ms). Skips models we know are gone instead of paying a round-trip each call. */
const goneModels = new Map<string, number>();
const GONE_TTL_MS = 60 * 60 * 1000;

function isGone(label: string, model: string): boolean {
  const until = goneModels.get(`${label}/${model}`);
  return until !== undefined && until > Date.now();
}

function isQuotaError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /429|quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GeminiAttempt {
  client: GoogleGenerativeAI;
  model: string;
  label: 'primary' | 'backup';
}

export interface GeminiFallbackOptions {
  /** When false, never use GEMINI_API_KEY_BACKUP (for bulk cron e.g. weekly briefings). */
  includeBackupKey?: boolean;
}

/** Primary key with its model chain, then optionally the backup key with its own chain. */
function buildAttempts(primaryModels: string[], options?: GeminiFallbackOptions): GeminiAttempt[] {
  const attempts: GeminiAttempt[] = primaryModels.map((model) => ({
    client: genAI,
    model,
    label: 'primary',
  }));
  if (backupAI && options?.includeBackupKey !== false) {
    for (const model of BACKUP_MODELS) {
      attempts.push({ client: backupAI, model, label: 'backup' });
    }
  }
  const live = attempts.filter((a) => !isGone(a.label, a.model));
  // If everything is marked gone, try anyway rather than fail without a request.
  return live.length > 0 ? live : attempts;
}

export async function generateWithRetryAndFallback<T>(
  models: string[],
  fn: (model: GenerativeModel) => Promise<T>,
  options?: GeminiFallbackOptions,
  modelParams?: Omit<ModelParams, 'model'>
): Promise<T> {
  const attempts = buildAttempts(models, options);
  const maxRetries = 2;
  let lastError: unknown;

  for (let i = 0; i < attempts.length; i++) {
    const { client, model, label } = attempts[i];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn(client.getGenerativeModel({ ...modelParams, model }));
        // One fallback per call that the primary model on the primary key didn't serve.
        if (label !== 'primary' || model !== models[0]) void recordAiFallback();
        return result;
      } catch (err) {
        lastError = err;
        if (isModelGoneError(err)) {
          if (!isGone(label, model)) {
            logger.error(
              { label, model },
              'Gemini model unavailable (retired or misspelled) — fix the model config'
            );
          }
          goneModels.set(`${label}/${model}`, Date.now() + GONE_TTL_MS);
          break;
        }
        if (isQuotaError(err)) {
          // A quota/rate-limit error affects the key, not the model — skip the
          // rest of this key's models and move straight to the next key.
          logger.warn({ label, model }, 'Gemini key rate-limited; switching key');
          while (i + 1 < attempts.length && attempts[i + 1].client === client) i++;
          break;
        }
        if (!isRetryableError(err) || attempt === maxRetries) break;
        const delay = (attempt + 1) * 1500;
        logger.warn(
          { err, label, model, attempt: attempt + 1, delay },
          'Gemini attempt failed, retrying'
        );
        await sleep(delay);
      }
    }
    if (i < attempts.length - 1) {
      logger.warn(
        { from: `${label}/${model}`, to: `${attempts[i + 1].label}/${attempts[i + 1].model}` },
        'Switching Gemini model after failure'
      );
    }
  }

  void recordAiFallback();
  throw lastError;
}

function usageFromMetadata(meta: unknown): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} {
  if (!meta || typeof meta !== 'object') {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  }
  const m = meta as {
    totalTokenCount?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
  const inputTokens = num(m.promptTokenCount);
  // Thinking tokens are billed as output; the SDK types omit the field but the API returns it.
  let outputTokens = num(m.candidatesTokenCount) + num(m.thoughtsTokenCount);
  const total = num(m.totalTokenCount);
  if (total > inputTokens + outputTokens) outputTokens = total - inputTokens;
  // Prompt tokens Gemini served from its implicit/explicit context cache (part of promptTokenCount).
  const cachedInputTokens = Math.min(num(m.cachedContentTokenCount), inputTokens);
  return { inputTokens, outputTokens, cachedInputTokens };
}

/** Records the call and returns what it cost (nano-USD at list price). */
function recordGeminiSuccess(
  kind: AiMetricKind,
  userId: string | undefined,
  usageMetadata: unknown,
  model: string
): number {
  void recordAiUsage(kind);
  const usage = usageFromMetadata(usageMetadata);
  if (userId) void recordUserAiUsage(userId, kind, { model, ...usage });
  return costNanoUsd(
    normalizeModelName(model),
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens
  );
}

/** Primary model first, then the shared fallbacks (without repeating the primary). */
const modelChain = (primary: string): string[] => [
  primary,
  ...FALLBACK_MODELS.filter((m) => m !== primary),
];

/** How long an identical request's reply is reused from Redis, per task. */
export const AI_CACHE_TTL = {
  parse: 24 * 60 * 60, // date, currency and the user's category history are in the key
  suggest: 7 * 24 * 60 * 60,
  budget: 24 * 60 * 60,
  ocr: 24 * 60 * 60, // same file bytes → same text (retries, re-uploads)
  insights: 6 * 60 * 60,
  advisor: 60 * 60,
} as const;

export interface GenerateOptions {
  /**
   * Static instructions, sent as systemInstruction. Keep this byte-identical across calls and
   * put per-user/per-request data in the contents: Gemini's implicit cache bills a repeated
   * prompt prefix at ~10% of the input price once the prefix is long enough.
   */
  systemInstruction?: string;
  /** Request application/json, and only cache replies that parse as JSON. */
  json?: boolean;
  /** Reuse an identical request's reply from Redis for this many seconds. Omit to always call. */
  cacheTtlSeconds?: number;
  /** Cache key namespace when several metric kinds run the same task. Defaults to the kind. */
  cacheNamespace?: string;
  fallbackOptions?: GeminiFallbackOptions;
}

/**
 * One Gemini text generation with retry/fallback, usage accounting and the response cache.
 * Every generateContent call in this service goes through here.
 */
async function generate(
  models: string[],
  contents: AiContents,
  kind: AiMetricKind,
  userId: string | undefined,
  options: GenerateOptions = {}
): Promise<string> {
  const { systemInstruction, json, cacheTtlSeconds, cacheNamespace, fallbackOptions } = options;
  const cacheKey =
    cacheTtlSeconds && aiResponseCacheEnabled()
      ? aiResponseCacheKey(cacheNamespace ?? kind, systemInstruction ?? '', contents)
      : null;

  if (cacheKey) {
    const hit = await getCachedAiResponse(cacheKey);
    if (hit) {
      void recordAiCacheHit(kind, hit.costNanoUsd);
      return hit.text;
    }
  }

  let costNano = 0;
  const text = await generateWithRetryAndFallback(
    models,
    async (model) => {
      const result = await model.generateContent(contents);
      costNano = recordGeminiSuccess(kind, userId, result.response.usageMetadata, model.model);
      return result.response.text();
    },
    fallbackOptions,
    {
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
    }
  );

  if (cacheKey && isCacheable(text, json)) {
    await setCachedAiResponse(cacheKey, { text, costNanoUsd: costNano }, cacheTtlSeconds!);
  }
  return text;
}

/** Never cache an empty or unparseable reply — it would be served back for the whole TTL. */
function isCacheable(text: string, json?: boolean): boolean {
  if (!text?.trim()) return false;
  if (!json) return true;
  try {
    extractJson(text);
    return true;
  } catch {
    return false;
  }
}

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';

/**
 * Run a text prompt against the insights model with retry + fallback.
 * Shared by the advisor/briefing/search services.
 */
export const runInsightsModel = async (
  prompt: string,
  metricKind: AiMetricKind = 'insights',
  fallbackOptions?: GeminiFallbackOptions,
  userId?: string,
  options?: Omit<GenerateOptions, 'fallbackOptions'>
): Promise<string> =>
  generate(modelChain(INSIGHTS_MODEL), prompt, metricKind, userId, {
    ...options,
    fallbackOptions,
  });

/**
 * Run a text prompt against the (fast) parsing model with retry + fallback.
 */
export const runParsingModel = async (
  prompt: string,
  metricKind: AiMetricKind = 'parse',
  userId?: string,
  options?: GenerateOptions
): Promise<string> => generate(modelChain(PARSING_MODEL), prompt, metricKind, userId, options);

/** Strip markdown fences and extract the first JSON object/array from a model reply. */
export const extractJson = (raw: string): any => {
  let text = raw
    .trim()
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '');
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  const objectMatch = text.match(/\{[\s\S]*\}/);
  // Prefer whichever structure starts first in the reply
  if (arrayMatch && objectMatch) {
    text =
      text.indexOf(arrayMatch[0]) <= text.indexOf(objectMatch[0]) ? arrayMatch[0] : objectMatch[0];
  } else if (arrayMatch) {
    text = arrayMatch[0];
  } else if (objectMatch) {
    text = objectMatch[0];
  }
  return JSON.parse(text);
};

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
   - If no date mentioned, use the default date given with the input
5. If currency is mentioned, use it; otherwise use the default currency given below
6. Assign confidence score (0-1) based on clarity
7. ALWAYS return an array, even for single expense
8. Input may be in Bangla (বাংলা), Banglish (Bangla in Latin letters), Hindi, Urdu or mixed with English:
   - Bangla digits are numbers: "চা ৫০" → amount 50, "রিকশা ১২০" → amount 120
   - "৳", "টাকা", "tk", "taka" mean BDT
   - Separators: "," "।" "এবং" "আর" split expenses like "and"
   - Dates: "আজ" = today, "গতকাল" = yesterday, "গত পরশু" = 2 days ago
   - Keep "description" in the user's own words and script (e.g. "চা", "rickshaw bhara")
   - "category" is ALWAYS in English (e.g. "চা" → "Tea & Snacks", "রিকশা" → "Local Transport", "বাজার" → "Groceries")
   - "amount" is ALWAYS a plain JSON number with ASCII digits (50, not "৫০")

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

The input comes with the user's category history (if any). Use the user's past
categorizations to maintain CONSISTENCY: if a similar expense exists, use the same category.

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
- The default date for this batch is given with the input — use it unless the input names a different date
- Be SPECIFIC with categories
Be precise. Return ONLY valid JSON array with ALL expenses found.`;

const INSIGHT_SYSTEM_PROMPT = `You are a personal financial advisor. Analyze the user's real expense data and tell them something genuinely useful about their money.

RULES:
1. Ground every insight in the actual numbers provided — quote amounts and percentages
2. Point out what changed and WHY it likely changed (which purchases drove it)
3. When you spot an opportunity to save, say so concretely ("Cutting X to twice a week saves ~Y/month")
4. Maximum 3 insights per analysis, one sentence or two each
5. Be honest but never judgmental or preachy
6. Never invent numbers that are not derivable from the data

TONE: A sharp, friendly advisor who respects the user's time`;

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
 * Parse natural language expenses into structured data using Gemini.
 * `defaultDate` is the Quick Log picker day (YYYY-MM-DD). Callers also stamp
 * that day after this returns so Gemini cannot replace it with "today".
 */
export async function parseExpenses(
  rawInput: string,
  userCurrency: string = 'USD',
  userContext: UserContext[] = [],
  defaultDate?: string,
  metricKind: AiMetricKind = 'parse',
  userId?: string
): Promise<ParsedExpense[]> {
  try {
    // Build rich context from user's history
    let contextHint = '';
    if (userContext.length > 0) {
      contextHint = "\n\nUSER'S CATEGORY HISTORY (learn from this):\n";
      userContext.forEach((c) => {
        const usage = c.confidence ? Math.round(c.confidence * 10) : 1;
        contextHint += `  - "${c.keyword}" → "${c.category}" (used ${usage}x)\n`;
      });
      contextHint +=
        '\nUse these patterns for CONSISTENCY. If similar expense exists, use same category.';
    } else {
      contextHint = '\n\nNO HISTORY: This is a new user. Suggest specific, meaningful categories.';
    }

    const selectedDate = defaultDate || new Date().toISOString().split('T')[0];

    // Static rules go in the system instruction (shared cached prefix); per-user history,
    // then per-request values, follow in order of how often they change.
    const userPrompt = `${contextHint.trim()}

Default currency: ${userCurrency}
Default date: ${selectedDate}

Parse this expense input:
"""
${normalizeDigits(rawInput)}
"""

REMEMBER:
- Suggest SPECIFIC categories (not generic)
- Use user's patterns for consistency
- Return ALL expenses as JSON array
- Use ${selectedDate} for every expense unless the text names a different date

Return JSON array of expenses:`;

    const responseText = await generate(modelChain(PARSING_MODEL), userPrompt, metricKind, userId, {
      systemInstruction: PARSING_SYSTEM_PROMPT,
      json: true,
      cacheTtlSeconds: AI_CACHE_TTL.parse,
      cacheNamespace: 'parse', // sync and async parses share entries
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

    // Validate and normalize. Use fixed catalog category when there's a strong match.
    return expenses.map((exp) => {
      const description = String(exp.description || '').trim();
      const aiCategory = String(exp.category || 'Other').trim();
      const catalogCategory = findCategoryFromCatalog(description);

      return {
        description,
        amount: parseAmount(exp.amount),
        currency: String(exp.currency || userCurrency).toUpperCase(),
        category: catalogCategory || aiCategory,
        confidence: catalogCategory ? 0.99 : parseFloat(exp.confidence) || 0.5,
        date: exp.date || selectedDate,
        rawInput: exp.rawInput || rawInput,
      };
    });
  } catch (error: any) {
    logger.error({ err: error }, 'Gemini parsing error');
    if (isRetryableError(error)) {
      throw new Error('Our AI service is temporarily busy. Please try again in a moment.');
    }
    throw new Error(`Failed to parse expenses: ${error.message}`);
  }
}

export const parseCategoryBudgets = async (
  text: string,
  knownCategories: string[] = [],
  userId?: string
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
${normalizeDigits(text)}
"""

Return ONLY a JSON array like:
[
  { "category": "Groceries", "limit": 4000 },
  { "category": "Health", "limit": 5000 }
]

Rules:
- "category" must be a short, human-readable label (match known categories when possible).
- "limit" is a number with ASCII digits (no currency symbol).
- Input may be Bangla or Banglish (e.g. "খাবার ৫০০০, বাসা ভাড়া ১৫০০০"); always return English category labels.
- Ignore unrelated text.
`;

    const rawText = await generate(modelChain(PARSING_MODEL), prompt, 'budget_category', userId, {
      json: true,
      cacheTtlSeconds: AI_CACHE_TTL.budget,
    });

    let jsonText = rawText
      .trim()
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '');

    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonText = arrayMatch[0];

    const parsed = JSON.parse(jsonText);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return items
      .map((i: any) => ({
        category: String(i.category || '').trim(),
        limit: parseAmount(i.limit),
      }))
      .filter((i) => i.category && !isNaN(i.limit) && i.limit > 0);
  } catch (error: any) {
    logger.error({ err: error }, 'parseCategoryBudgets error');
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
  userContext: UserContext[] = [],
  userId?: string
): Promise<{ category: string; confidence: number; alternatives?: string[] }> => {
  try {
    let contextHint = '';
    if (userContext.length > 0) {
      contextHint = "User's past patterns:\n";
      userContext.slice(0, 10).forEach((c) => {
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

    const rawText = await generate(modelChain(PARSING_MODEL), prompt, 'parse', userId, {
      json: true,
      cacheTtlSeconds: AI_CACHE_TTL.suggest,
    });
    let jsonText = rawText.trim();

    // Remove markdown
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    const parsed = JSON.parse(jsonText);
    return parsed;
  } catch (error: any) {
    logger.error({ err: error }, 'Category suggestion error');
    return {
      category: 'Other',
      confidence: 0.5,
      alternatives: [],
    };
  }
};

/**
 * Generate embedding for text (for RAG)
 * Uses full 3072-dimensional embeddings from gemini-embedding-001
 */
export const generateEmbedding = async (text: string, userId?: string): Promise<number[]> => {
  const input = text.replace(/\s+/g, ' ').trim().slice(0, 4000) || 'expense';
  const clients: Array<{ client: GoogleGenerativeAI; label: string }> = [
    { client: genAI, label: 'primary' },
  ];
  if (backupAI) clients.push({ client: backupAI, label: 'backup' });

  let lastError: any;
  for (let i = 0; i < clients.length; i++) {
    const { client, label } = clients[i];
    try {
      const model = client.getGenerativeModel({ model: EMBEDDING_MODEL });
      const result = await model.embedContent(input);
      const values = result.embedding?.values;
      if (!isValidEmbedding(values)) {
        throw new Error(
          `Embedding length ${Array.isArray(values) ? values.length : typeof values} != Pinecone dimension ${EMBEDDING_DIMENSIONS}`
        );
      }
      void recordAiUsage('embedding');
      if (userId) {
        const estTokens = Math.max(1, Math.ceil(input.length / 4));
        void recordUserAiUsage(userId, 'embedding', {
          model: EMBEDDING_MODEL,
          inputTokens: estTokens,
          outputTokens: 0,
        });
      }
      return values as number[];
    } catch (error: any) {
      lastError = error;
      logger.error({ err: error, label }, 'Embedding generation error');
      if (i < clients.length - 1) void recordAiFallback();
    }
  }
  throw new Error(`Failed to generate embedding: ${lastError?.message}`);
};

/**
 * Generate insights from expense data
 */
export const generateInsights = async (
  expenses: any[],
  summary: ExpenseSummary,
  comparisonContext?: string,
  userId?: string
): Promise<string[]> => {
  try {
    if (expenses.length === 0) {
      return ['No expenses to analyze yet. Start tracking to get insights!'];
    }

    const expenseList = expenses
      .slice(0, 50)
      .map((e) => `${e.description} (${e.category}): ${e.amount} ${e.currency}`)
      .join('\n');

    const prompt = `EXPENSE DATA (last ${expenses.length} transactions):
${expenseList}

SUMMARY:
- Total spent: ${summary.totalSpent} ${summary.currency}
- Top categories: ${summary.topCategories.join(', ')}
- Category breakdown: ${JSON.stringify(summary.byCategory)}
${comparisonContext ? `\nCOMPARISON WITH PREVIOUS PERIOD:\n${comparisonContext}\n` : ''}
Generate 2-3 insights about this spending. Explain what changed and why,
and include at least one concrete, realistic saving opportunity when the data supports it.

Return as JSON array of strings:
["Insight 1", "Insight 2", "Insight 3"]`;

    const rawText = await generate(modelChain(INSIGHTS_MODEL), prompt, 'insights', userId, {
      systemInstruction: INSIGHT_SYSTEM_PROMPT,
      json: true,
      cacheTtlSeconds: AI_CACHE_TTL.insights,
    });
    let jsonText = rawText.trim();

    // Remove markdown
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    const insights = JSON.parse(jsonText);
    return Array.isArray(insights) ? insights : [insights];
  } catch (error: any) {
    logger.error({ err: error }, 'Insight generation error');
    return ['Unable to generate insights at this time.'];
  }
};

export { ParsedExpense, UserContext, ExpenseSummary };

// ---------------------------------------------------------------------------
// Receipt OCR (Gemini vision): extract expense lines from a receipt image
// ---------------------------------------------------------------------------
export const extractReceiptText = async (
  imageBase64: string,
  mimeType: string,
  userId?: string
): Promise<string> => {
  const prompt = `You are reading a photo of a receipt, invoice, or a handwritten/printed list of expenses.
Extract every purchasable line item with its price.

OUTPUT RULES:
- Output PLAIN TEXT ONLY: one expense per line, formatted as "<description> <amount>"
- Use the item names as written (short, human-readable)
- Amounts: numbers only, no currency symbols
- Skip subtotals, tax lines, change, card numbers, addresses and totals — items only.
  If only a grand total is readable, output one line: "<store name> <total>"
- If the image contains no readable expenses, output exactly: NONE`;

  const text = await generate(
    modelChain(PARSING_MODEL),
    [{ inlineData: { data: imageBase64, mimeType } }, prompt],
    'ocr',
    userId,
    { cacheTtlSeconds: AI_CACHE_TTL.ocr }
  );

  const cleaned = (text || '').trim();
  if (!cleaned || /^NONE$/i.test(cleaned)) return '';
  return cleaned;
};

/** OCR for PDF/image imports (statements, exports, scans). Returns plain text for parseExpenses. */
export const extractImportDocumentText = async (
  fileBase64: string,
  mimeType: string,
  userId?: string
): Promise<string> => {
  const prompt = `You are reading a financial document: PDF export, bank statement, receipt bundle, or expense list photo.

Extract EVERY individual expense / transaction you can see.

OUTPUT RULES:
- PLAIN TEXT ONLY — one transaction per line
- Prefer: "<YYYY-MM-DD or date as shown> <description> <amount>" when a date is visible
- Otherwise: "<description> <amount>" per line
- Amounts: numbers only (no currency symbols). Use positive numbers for money spent.
- Include purchases, fees, transfers out, subscriptions — skip running balances, account numbers, page headers, and duplicate grand totals
- If the document is a table, emit one line per row
- If nothing is readable, output exactly: NONE`;

  const text = await generate(
    modelChain(PARSING_MODEL),
    [{ inlineData: { data: fileBase64, mimeType } }, prompt],
    'ocr',
    userId,
    { cacheTtlSeconds: AI_CACHE_TTL.ocr }
  );

  const cleaned = (text || '').trim();
  if (!cleaned || /^NONE$/i.test(cleaned)) return '';
  return cleaned;
};
