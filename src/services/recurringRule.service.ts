/**
 * Scheduling helpers for user-confirmed recurring expenses.
 * Dates are computed in UTC so a rule fires on the same calendar day
 * regardless of which server timezone the worker runs in.
 */

export type Frequency = 'weekly' | 'monthly';

export const FREQUENCIES: Frequency[] = ['weekly', 'monthly'];

/** Clamp a day-of-month to a month that may be shorter (e.g. 31 -> 28 in Feb). */
function clampDayOfMonth(year: number, month: number, day: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

/**
 * First run strictly after `from`. A rule created on its own due day waits
 * until the next cycle, because the expense that created it already exists.
 */
export function computeNextRun(
  frequency: Frequency,
  options: { dayOfMonth?: number | null; dayOfWeek?: number | null },
  from: Date = new Date()
): Date {
  const base = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 9, 0, 0, 0)
  );

  if (frequency === 'weekly') {
    const target = options.dayOfWeek ?? base.getUTCDay();
    const next = new Date(base);
    const delta = (target - base.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + (delta === 0 ? 7 : delta));
    return next;
  }

  const desiredDay = options.dayOfMonth ?? base.getUTCDate();
  const thisMonth = new Date(base);
  thisMonth.setUTCDate(clampDayOfMonth(base.getUTCFullYear(), base.getUTCMonth(), desiredDay));

  if (thisMonth > base) return thisMonth;

  const year = base.getUTCMonth() === 11 ? base.getUTCFullYear() + 1 : base.getUTCFullYear();
  const month = (base.getUTCMonth() + 1) % 12;
  const next = new Date(Date.UTC(year, month, 1, 9, 0, 0, 0));
  next.setUTCDate(clampDayOfMonth(year, month, desiredDay));
  return next;
}

/** Advance a rule after a successful run, skipping any missed cycles. */
export function advanceNextRun(
  frequency: Frequency,
  options: { dayOfMonth?: number | null; dayOfWeek?: number | null },
  previousRun: Date,
  now: Date = new Date()
): Date {
  let next = computeNextRun(frequency, options, previousRun);
  let guard = 0;
  while (next <= now && guard < 60) {
    next = computeNextRun(frequency, options, next);
    guard += 1;
  }
  return next;
}
