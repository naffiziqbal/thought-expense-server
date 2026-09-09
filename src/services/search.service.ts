/**
 * Natural-language search over expense history.
 * Combines three signals and merges the results:
 *   1. AI query parsing -> structured filters (dates, category, amount range)
 *   2. Semantic vector search (Pinecone, already populated per expense)
 *   3. Plain substring match on descriptions
 */

import prisma from '../config/prisma';
import { runParsingModel, extractJson, generateEmbedding } from './gemini.service';
import { querySimilarExpenses } from './pinecone.service';
import { convertAmountsToCurrency } from './exchangeRate.service';
import { logger } from '../config/logger';

export interface ParsedSearchQuery {
  semanticQuery: string;
  category?: string;
  startDate?: string;
  endDate?: string;
  minAmount?: number;
  maxAmount?: number;
}

export interface SearchResultExpense {
  id: string;
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: Date;
  matchType: 'semantic' | 'keyword' | 'both';
}

export interface SearchResult {
  query: string;
  parsed: ParsedSearchQuery;
  expenses: SearchResultExpense[];
  total: number;
  totalAmount: number;
  currency: string;
}

/**
 * Turn a free-text question ("food last month over 500") into structured
 * filters. Falls back to a pure semantic query if parsing fails.
 */
async function parseSearchQuery(query: string): Promise<ParsedSearchQuery> {
  try {
    const prompt = `Parse this expense-history search query into filters.
Today is ${new Date().toISOString().split('T')[0]}.

Query: "${query}"

Return JSON (omit fields that are not in the query; keep "semanticQuery" as the
core thing being searched for, stripped of dates/amount qualifiers):
{
  "semanticQuery": "what to search for",
  "category": "Category name if the query names one",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "minAmount": 100,
  "maxAmount": 500
}`;
    const raw = await runParsingModel(prompt);
    const parsed = extractJson(raw);
    return {
      semanticQuery: String(parsed.semanticQuery || query).trim() || query,
      category: parsed.category ? String(parsed.category) : undefined,
      startDate: parsed.startDate ? String(parsed.startDate) : undefined,
      endDate: parsed.endDate ? String(parsed.endDate) : undefined,
      minAmount: parsed.minAmount != null ? Number(parsed.minAmount) : undefined,
      maxAmount: parsed.maxAmount != null ? Number(parsed.maxAmount) : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Search query parse failed, using raw query');
    return { semanticQuery: query };
  }
}

export async function searchExpenses(
  userId: string,
  query: string,
  userCurrency: string,
  isPremium: boolean,
  limit: number = 30
): Promise<SearchResult> {
  const parsed = await parseSearchQuery(query);

  // Free tier: history capped at 3 months, matching the rest of the API
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (parsed.startDate) dateFilter.gte = new Date(parsed.startDate);
  if (parsed.endDate) dateFilter.lte = new Date(parsed.endDate);
  if (!isPremium) {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    if (!dateFilter.gte || dateFilter.gte < threeMonthsAgo) dateFilter.gte = threeMonthsAgo;
  }

  const structuredWhere: any = { userId };
  if (dateFilter.gte || dateFilter.lte) structuredWhere.date = dateFilter;
  if (parsed.category) structuredWhere.category = { equals: parsed.category, mode: 'insensitive' };
  if (parsed.minAmount != null || parsed.maxAmount != null) {
    structuredWhere.amount = {};
    if (parsed.minAmount != null) structuredWhere.amount.gte = parsed.minAmount;
    if (parsed.maxAmount != null) structuredWhere.amount.lte = parsed.maxAmount;
  }

  // Signal A: semantic matches from Pinecone
  let semanticIds: string[] = [];
  try {
    const embedding = await generateEmbedding(parsed.semanticQuery);
    const matches = await querySimilarExpenses(embedding, userId, 30);
    semanticIds = matches
      .filter((m: any) => (m.score ?? 0) >= 0.5)
      .map((m: any) => m.metadata?.expenseId || m.id)
      .filter(Boolean);
  } catch (err) {
    logger.warn({ err }, 'Semantic search unavailable, falling back to keyword only');
  }

  // Signal B: keyword matches in Postgres
  const keywordRows = await prisma.expense.findMany({
    where: {
      ...structuredWhere,
      description: { contains: parsed.semanticQuery, mode: 'insensitive' },
    },
    orderBy: { date: 'desc' },
    take: limit,
  });
  const keywordIds = new Set(keywordRows.map((e) => e.id));

  // Semantic hits must still respect the structured filters
  const semanticRows = semanticIds.length
    ? await prisma.expense.findMany({
        where: { ...structuredWhere, id: { in: semanticIds } },
        orderBy: { date: 'desc' },
        take: limit,
      })
    : [];
  const semanticIdSet = new Set(semanticRows.map((e) => e.id));

  // Merge, keyword-first is irrelevant after sorting by date
  const mergedById = new Map<string, (typeof keywordRows)[number]>();
  for (const row of [...keywordRows, ...semanticRows]) {
    if (!mergedById.has(row.id)) mergedById.set(row.id, row);
  }
  const merged = [...mergedById.values()]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit);

  const converted = await convertAmountsToCurrency(merged, userCurrency);
  const totalAmount = Math.round(converted.reduce((a, b) => a + b.amount, 0) * 100) / 100;

  return {
    query,
    parsed,
    expenses: converted.map((e) => ({
      id: e.id,
      description: e.description,
      amount: e.amount,
      currency: e.currency,
      category: e.category,
      date: e.date,
      matchType:
        keywordIds.has(e.id) && semanticIdSet.has(e.id)
          ? 'both'
          : keywordIds.has(e.id)
            ? 'keyword'
            : 'semantic',
    })),
    total: merged.length,
    totalAmount,
    currency: userCurrency,
  };
}
