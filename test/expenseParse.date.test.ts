import { describe, expect, it } from 'vitest';
import {
  applySelectedExpenseDate,
  expenseDateFromYmd,
  normalizeExpenseYmd,
  resolveSelectedExpenseDate,
} from '../src/services/expenseParse.service';

describe('expense parse dates', () => {
  it('normalizes picker and ISO values to YYYY-MM-DD', () => {
    expect(normalizeExpenseYmd('2026-09-17')).toBe('2026-09-17');
    expect(normalizeExpenseYmd('2026-09-17T18:30:00.000Z')).toBe('2026-09-17');
    expect(normalizeExpenseYmd('not-a-date')).toBeUndefined();
    expect(normalizeExpenseYmd(12)).toBeUndefined();
  });

  it('prefers the explicit date over localPreview', () => {
    expect(
      resolveSelectedExpenseDate({
        date: '2026-01-02',
        localPreview: [{ date: '2026-01-01' }],
      })
    ).toBe('2026-01-02');
  });

  it('falls back to the first localPreview date', () => {
    expect(
      resolveSelectedExpenseDate({
        localPreview: [{ date: '2026-03-04T12:00:00.000Z' }],
      })
    ).toBe('2026-03-04');
  });

  it('stamps every parsed row with the selected date', () => {
    const stamped = applySelectedExpenseDate(
      [
        { date: '2026-09-17', description: 'Coffee' },
        { date: '2026-09-16', description: 'Uber' },
      ],
      '2026-01-05'
    );
    expect(stamped.map((e) => e.date)).toEqual(['2026-01-05', '2026-01-05']);
  });

  it('stores calendar days at noon UTC so they do not slip', () => {
    const date = expenseDateFromYmd('2026-09-17');
    expect(date.toISOString()).toBe('2026-09-17T12:00:00.000Z');
  });
});
