/**
 * Recurring-expense detection (conservative, to avoid false positives).
 * Pure function so it can be tested without the DB.
 */

export interface RecurringCandidate {
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: Date;
}

export interface RecurringExpense {
  description: string;
  category: string;
  averageAmount: number;
  currency: string;
  occurrences: number;
  monthsSeen: number;
  lastDate: string;
}

function normalizeDescription(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/^\d+\.\s*/, '')
    .replace(/[\d,.]+/g, ' ')
    .replace(/[^a-zঀ-৿\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Detect recurring expenses: same normalized description appearing in at
 * least `minMonths` distinct calendar months with amounts within ±25% of
 * the group's median. Returns the top matches by monthly cost.
 */
export function detectRecurring(
  expenses: RecurringCandidate[],
  minMonths: number = 3
): RecurringExpense[] {
  const groups = new Map<string, RecurringCandidate[]>();

  for (const expense of expenses) {
    const key = normalizeDescription(expense.description);
    if (key.length < 3) continue;
    const list = groups.get(key);
    if (list) list.push(expense);
    else groups.set(key, [expense]);
  }

  const results: RecurringExpense[] = [];

  for (const members of groups.values()) {
    if (members.length < minMonths) continue;

    const med = median(members.map((m) => m.amount));
    if (med <= 0) continue;

    // Keep only amounts close to the median (subscriptions/bills are stable)
    const stable = members.filter((m) => Math.abs(m.amount - med) / med <= 0.25);
    if (stable.length < minMonths) continue;

    const months = new Set(
      stable.map((m) => `${m.date.getFullYear()}-${m.date.getMonth() + 1}`)
    );
    if (months.size < minMonths) continue;

    const latest = stable.reduce((a, b) => (a.date > b.date ? a : b));
    results.push({
      description: latest.description,
      category: latest.category,
      averageAmount: Math.round(median(stable.map((m) => m.amount)) * 100) / 100,
      currency: latest.currency,
      occurrences: stable.length,
      monthsSeen: months.size,
      lastDate: latest.date.toISOString(),
    });
  }

  return results.sort((a, b) => b.averageAmount - a.averageAmount).slice(0, 10);
}
