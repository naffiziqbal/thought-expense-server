import { describe, expect, it } from 'vitest';
import { parseExpenseImportCsv } from '../src/services/expenseImport.service';

describe('parseExpenseImportCsv', () => {
  it('parses ThoughtExpense export shape', () => {
    const csv = `Date,Description,Category,Amount,Currency
2024-03-01,"Coffee shop",Food,4.50,USD
2024-03-02,Uber,Transport,12,USD
"Total Expense","","",16.50,USD
`;
    const result = parseExpenseImportCsv(Buffer.from(csv, 'utf8'), 'USD');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: '2024-03-01',
      description: 'Coffee shop',
      category: 'Food',
      amount: 4.5,
      currency: 'USD',
    });
    expect(result.skippedRows).toBeGreaterThanOrEqual(1);
  });

  it('accepts alternate column names', () => {
    const csv = `transaction date,memo,debit
2024-01-15,Grocery run,45.20
`;
    const result = parseExpenseImportCsv(Buffer.from(csv, 'utf8'), 'BDT');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].description).toBe('Grocery run');
    expect(result.rows[0].currency).toBe('BDT');
  });
});
