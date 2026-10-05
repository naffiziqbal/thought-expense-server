import { describe, expect, it } from 'vitest';
import { searchExpenses } from '../src/services/search.service';
import prisma from '../src/config/prisma';
import { deleteUsersByIds, signupUser } from './helpers';

describe('searchExpenses (plain text)', () => {
  it('finds expenses by description substring', async () => {
    const account = await signupUser();
    const userId = account.user.id;
    try {
      await prisma.expense.create({
        data: {
          userId,
          description: 'Vara Fashion purchase',
          amount: 120,
          currency: 'BDT',
          category: 'Shopping',
          confidence: 1,
          date: new Date(),
        },
      });

      const result = await searchExpenses(userId, 'Vara', 'BDT', true, 20);
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.expenses.some((e) => e.description.includes('Vara'))).toBe(true);
    } finally {
      await deleteUsersByIds([userId]);
    }
  });
});
