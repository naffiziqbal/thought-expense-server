/**
 * Spending intelligence: anomaly, trend and waste detection.
 * The detectors are pure functions over currency-normalized expenses so they
 * can be tested without the DB; getSpendingIntelligence() wires them to Prisma.
 */

import prisma from '../config/prisma';
import { convertAmountsToCurrency } from './exchangeRate.service';
import { getCache, setCache } from '../config/redis';
import { detectRecurring, RecurringExpense } from './recurring.service';

export interface AnalyticsExpense {
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: Date;
}

export interface CategoryAnomaly {
  type: 'category_spike';
  category: string;
  currentAmount: number;
  baselineAmount: number; // median of prior months
  changePercent: number;
  currency: string;
  message: string;
}

export interface TransactionAnomaly {
  type: 'large_transaction';
  description: string;
  category: string;
  amount: number;
  typicalAmount: number;
  currency: string;
  date: string;
  message: string;
}

export type Anomaly = CategoryAnomaly | TransactionAnomaly;

export interface CategoryTrend {
  category: string;
  monthlyAmounts: number[]; // oldest -> newest, includes current month
  changePercent: number; // first vs last month of the window
  currency: string;
  message: string;
}

export interface WasteFinding {
  type: 'price_creep' | 'overlapping_subscriptions' | 'small_leak';
  category: string;
  amount: number; // estimated monthly cost of the finding
  currency: string;
  message: string;
  items?: string[];
}

export interface MonthlySeriesPoint {
  month: string; // YYYY-MM
  total: number;
  byCategory: Record<string, number>;
}

export interface SpendingIntelligence {
  currency: string;
  windowMonths: number;
  monthlySeries: MonthlySeriesPoint[];
  anomalies: Anomaly[];
  trends: CategoryTrend[];
  waste: WasteFinding[];
  recurring: RecurringExpense[];
}

const monthKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Group expenses into a per-month, per-category series (oldest -> newest).
 */
export function buildMonthlySeries(expenses: AnalyticsExpense[]): MonthlySeriesPoint[] {
  const byMonth = new Map<string, MonthlySeriesPoint>();
  for (const e of expenses) {
    const key = monthKey(e.date);
    let point = byMonth.get(key);
    if (!point) {
      point = { month: key, total: 0, byCategory: {} };
      byMonth.set(key, point);
    }
    point.total = round2(point.total + e.amount);
    point.byCategory[e.category] = round2((point.byCategory[e.category] || 0) + e.amount);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Category spikes: current month's category total vs the median of prior
 * months. Conservative thresholds to avoid noise on small amounts.
 */
export function detectCategoryAnomalies(
  series: MonthlySeriesPoint[],
  currency: string
): CategoryAnomaly[] {
  if (series.length < 2) return [];
  const current = series[series.length - 1];
  const prior = series.slice(0, -1);

  const totalCurrent = current.total;
  if (totalCurrent <= 0) return [];

  const anomalies: CategoryAnomaly[] = [];
  for (const [category, amount] of Object.entries(current.byCategory)) {
    const baselineValues = prior.map((p) => p.byCategory[category] || 0);
    const baseline = median(baselineValues);
    if (baseline <= 0) {
      // New category: only flag if it is a meaningful share of the month
      if (amount >= totalCurrent * 0.15 && prior.length >= 2) {
        anomalies.push({
          type: 'category_spike',
          category,
          currentAmount: round2(amount),
          baselineAmount: 0,
          changePercent: 100,
          currency,
          message: `"${category}" is new this month and already ${round2(amount)} ${currency} (${Math.round((amount / totalCurrent) * 100)}% of your spending).`,
        });
      }
      continue;
    }
    const change = ((amount - baseline) / baseline) * 100;
    // Spike: at least +50% over baseline AND at least 5% of the month's total
    if (change >= 50 && amount >= totalCurrent * 0.05) {
      anomalies.push({
        type: 'category_spike',
        category,
        currentAmount: round2(amount),
        baselineAmount: round2(baseline),
        changePercent: Math.round(change),
        currency,
        message: `"${category}" is up ${Math.round(change)}% this month (${round2(amount)} ${currency} vs a typical ${round2(baseline)} ${currency}).`,
      });
    }
  }
  return anomalies.sort((a, b) => b.currentAmount - a.currentAmount).slice(0, 5);
}

/**
 * Unusually large single transactions in the current month, judged against
 * the user's own history in that category.
 */
export function detectLargeTransactions(
  expenses: AnalyticsExpense[],
  currency: string
): TransactionAnomaly[] {
  const now = new Date();
  const currentKey = monthKey(now);

  const byCategory = new Map<string, AnalyticsExpense[]>();
  for (const e of expenses) {
    const list = byCategory.get(e.category);
    if (list) list.push(e);
    else byCategory.set(e.category, [e]);
  }

  const anomalies: TransactionAnomaly[] = [];
  for (const [category, items] of byCategory) {
    const history = items.filter((e) => monthKey(e.date) !== currentKey);
    if (history.length < 5) continue; // not enough history to call anything unusual
    const amounts = history.map((e) => e.amount);
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const std = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length);
    const typical = median(amounts);
    const threshold = Math.max(mean + 2 * std, typical * 3);

    for (const e of items) {
      if (monthKey(e.date) !== currentKey) continue;
      if (e.amount >= threshold && e.amount >= typical * 2) {
        anomalies.push({
          type: 'large_transaction',
          description: e.description,
          category,
          amount: round2(e.amount),
          typicalAmount: round2(typical),
          currency,
          date: e.date.toISOString(),
          message: `"${e.description}" (${round2(e.amount)} ${currency}) is well above your usual ~${round2(typical)} ${currency} for ${category}.`,
        });
      }
    }
  }
  return anomalies.sort((a, b) => b.amount - a.amount).slice(0, 5);
}

/**
 * Rising categories: total increased in each of the last 3 months (allowing
 * one flat month) and is up at least 25% across the window.
 */
export function detectTrends(series: MonthlySeriesPoint[], currency: string): CategoryTrend[] {
  if (series.length < 3) return [];
  const window = series.slice(-4); // up to 4 most recent months

  const categories = new Set<string>();
  window.forEach((p) => Object.keys(p.byCategory).forEach((c) => categories.add(c)));

  const trends: CategoryTrend[] = [];
  for (const category of categories) {
    const amounts = window.map((p) => round2(p.byCategory[category] || 0));
    const first = amounts[0];
    const last = amounts[amounts.length - 1];
    if (first <= 0 || last <= 0) continue;

    let rises = 0;
    let falls = 0;
    for (let i = 1; i < amounts.length; i++) {
      if (amounts[i] > amounts[i - 1] * 1.02) rises++;
      else if (amounts[i] < amounts[i - 1] * 0.98) falls++;
    }
    const changePercent = ((last - first) / first) * 100;
    if (rises >= amounts.length - 2 && falls === 0 && changePercent >= 25) {
      trends.push({
        category,
        monthlyAmounts: amounts,
        changePercent: Math.round(changePercent),
        currency,
        message: `"${category}" has been climbing for ${amounts.length} months — up ${Math.round(changePercent)}% (${first} → ${last} ${currency}/month).`,
      });
    }
  }
  return trends.sort((a, b) => b.changePercent - a.changePercent).slice(0, 5);
}

/**
 * Potential waste: recurring price creep, overlapping subscriptions in the
 * same category, and "small leak" categories (many small purchases adding up).
 */
export function detectWaste(
  recurring: RecurringExpense[],
  expenses: AnalyticsExpense[],
  currency: string
): WasteFinding[] {
  const findings: WasteFinding[] = [];

  // Price creep: latest charge of a recurring item is >15% above its median
  for (const r of recurring) {
    const key = r.description.toLowerCase();
    const charges = expenses
      .filter((e) => e.description.toLowerCase() === key)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const latest = charges[charges.length - 1];
    if (latest && r.averageAmount > 0 && latest.amount > r.averageAmount * 1.15) {
      findings.push({
        type: 'price_creep',
        category: r.category,
        amount: round2(latest.amount - r.averageAmount),
        currency,
        message: `"${r.description}" now costs ${round2(latest.amount)} ${currency} — up from its usual ${r.averageAmount} ${currency}. Worth checking why.`,
        items: [r.description],
      });
    }
  }

  // Overlapping subscriptions: 2+ recurring charges in the same category
  const recurringByCategory = new Map<string, RecurringExpense[]>();
  for (const r of recurring) {
    const list = recurringByCategory.get(r.category);
    if (list) list.push(r);
    else recurringByCategory.set(r.category, [r]);
  }
  for (const [category, items] of recurringByCategory) {
    if (items.length >= 2) {
      const total = round2(items.reduce((a, b) => a + b.averageAmount, 0));
      findings.push({
        type: 'overlapping_subscriptions',
        category,
        amount: total,
        currency,
        message: `You pay for ${items.length} recurring "${category}" services (${total} ${currency}/month combined). Do you use them all?`,
        items: items.map((i) => i.description),
      });
    }
  }

  // Small leaks: categories with 8+ transactions this month, each under 5% of
  // the month's total, together exceeding 10% of the month
  const currentKey = monthKey(new Date());
  const thisMonth = expenses.filter((e) => monthKey(e.date) === currentKey);
  const monthTotal = thisMonth.reduce((a, b) => a + b.amount, 0);
  if (monthTotal > 0) {
    const byCategory = new Map<string, AnalyticsExpense[]>();
    for (const e of thisMonth) {
      const list = byCategory.get(e.category);
      if (list) list.push(e);
      else byCategory.set(e.category, [e]);
    }
    for (const [category, items] of byCategory) {
      const total = items.reduce((a, b) => a + b.amount, 0);
      const allSmall = items.every((e) => e.amount <= monthTotal * 0.05);
      if (items.length >= 8 && allSmall && total >= monthTotal * 0.1) {
        findings.push({
          type: 'small_leak',
          category,
          amount: round2(total),
          currency,
          message: `${items.length} small "${category}" purchases quietly added up to ${round2(total)} ${currency} this month (${Math.round((total / monthTotal) * 100)}% of your spending).`,
        });
      }
    }
  }

  return findings.sort((a, b) => b.amount - a.amount).slice(0, 6);
}

/**
 * Full intelligence bundle for a user. Premium looks back 12 months, free 3.
 * Cached for 1 hour (invalidated implicitly by TTL; expense writes clear the
 * summary caches but intelligence tolerates slight staleness).
 */
export async function getSpendingIntelligence(
  userId: string,
  userCurrency: string,
  isPremium: boolean
): Promise<SpendingIntelligence> {
  const cacheKey = `intelligence:${userId}:${userCurrency}:${isPremium ? 'p' : 'f'}`;
  const cached = await getCache<SpendingIntelligence>(cacheKey);
  if (cached) return cached;

  const windowMonths = isPremium ? 12 : 3;
  const since = new Date();
  since.setMonth(since.getMonth() - windowMonths);
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const rows = await prisma.expense.findMany({
    where: { userId, date: { gte: since } },
    select: { description: true, amount: true, currency: true, category: true, date: true },
    orderBy: { date: 'asc' },
    take: 5000,
  });

  const converted = (await convertAmountsToCurrency(rows, userCurrency)).map((e) => ({
    ...e,
    date: new Date(e.date),
  }));

  const series = buildMonthlySeries(converted);
  const recurring = detectRecurring(converted, isPremium ? 3 : 2);

  const intelligence: SpendingIntelligence = {
    currency: userCurrency,
    windowMonths,
    monthlySeries: series,
    anomalies: [
      ...detectCategoryAnomalies(series, userCurrency),
      ...detectLargeTransactions(converted, userCurrency),
    ],
    trends: detectTrends(series, userCurrency),
    waste: detectWaste(recurring, converted, userCurrency),
    recurring,
  };

  await setCache(cacheKey, intelligence, 3600);
  return intelligence;
}
