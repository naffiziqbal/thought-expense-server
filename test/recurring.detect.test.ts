import { describe, expect, it } from 'vitest';
import { detectRecurring } from '../src/services/recurring.service';

describe('detectRecurring', () => {
  it('finds a stable monthly charge across months', () => {
    const found = detectRecurring(
      [
        { description: 'Netflix', amount: 499, currency: 'BDT', category: 'Entertainment', date: new Date('2026-07-15') },
        { description: 'Netflix', amount: 499, currency: 'BDT', category: 'Entertainment', date: new Date('2026-08-15') },
        { description: 'Netflix', amount: 510, currency: 'BDT', category: 'Entertainment', date: new Date('2026-09-15') },
      ],
      3
    );

    expect(found).toHaveLength(1);
    expect(found[0].occurrences).toBe(3);
    expect(found[0].averageAmount).toBeGreaterThan(400);
  });

  it('ignores one-off spend', () => {
    const found = detectRecurring(
      [
        { description: 'Coffee', amount: 120, currency: 'BDT', category: 'Food', date: new Date('2026-09-01') },
        { description: 'Coffee', amount: 800, currency: 'BDT', category: 'Food', date: new Date('2026-09-02') },
      ],
      2
    );
    expect(found).toHaveLength(0);
  });
});
