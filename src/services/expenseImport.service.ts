import { parse } from 'csv-parse/sync';
import { PDFParse } from 'pdf-parse';
import { normalizeIso4217Code } from '../utils/iso4217';

export const EXPENSE_IMPORT_MAX_ROWS = 500;
export const EXPENSE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

const STANDARD_CATEGORIES = [
  'Food',
  'Transport',
  'Rent',
  'Utilities',
  'Shopping',
  'Entertainment',
  'Healthcare',
  'Education',
  'Personal Care',
  'Fees',
  'Other',
] as const;

export type ExpenseImportRow = {
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: string;
};

export type ExpenseImportPreview = {
  format: 'csv' | 'pdf';
  rows: ExpenseImportRow[];
  warnings: string[];
  skippedRows: number;
};

function normalizeCategory(raw: string | undefined): string {
  if (!raw?.trim()) return 'Other';
  const trimmed = raw.trim();
  const match = STANDARD_CATEGORIES.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  return match ?? 'Other';
}

function normalizeDate(raw: string | undefined, fallback: string): string {
  if (!raw?.trim()) return fallback;
  const s = raw.trim().slice(0, 10);
  const d = new Date(`${s}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString().slice(0, 10);
}

function parseAmount(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const cleaned = String(raw)
    .replace(/[,$\s]/g, '')
    .replace(/[()]/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function pickColumn(record: Record<string, string>, keys: string[]): string | undefined {
  const normalized = Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v])
  );
  for (const key of keys) {
    const nk = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized[nk] != null && String(normalized[nk]).trim() !== '') {
      return String(normalized[nk]).trim();
    }
  }
  return undefined;
}

function isTotalRow(description: string, amount: number | null): boolean {
  const d = description.toLowerCase();
  if (d.includes('total expense') || d === 'total') return true;
  if (!description && amount == null) return true;
  return false;
}

function capRows(rows: ExpenseImportRow[], warnings: string[]): ExpenseImportRow[] {
  if (rows.length <= EXPENSE_IMPORT_MAX_ROWS) return rows;
  warnings.push(`Only the first ${EXPENSE_IMPORT_MAX_ROWS} rows will be imported.`);
  return rows.slice(0, EXPENSE_IMPORT_MAX_ROWS);
}

export function parseExpenseImportCsv(
  buffer: Buffer,
  defaultCurrency: string
): ExpenseImportPreview {
  const warnings: string[] = [];
  let skippedRows = 0;
  const fallbackDate = new Date().toISOString().slice(0, 10);
  const defaultCode = normalizeIso4217Code(defaultCurrency) ?? 'USD';

  let records: Record<string, string>[];
  try {
    records = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    }) as Record<string, string>[];
  } catch {
    throw new Error('Could not read CSV. Check that the file is valid comma-separated text.');
  }

  const rows: ExpenseImportRow[] = [];
  for (const record of records) {
    const description =
      pickColumn(record, ['description', 'memo', 'payee', 'name', 'details', 'merchant']) ?? '';
    const amountRaw =
      pickColumn(record, ['amount', 'debit', 'expense', 'spent', 'cost']) ??
      pickColumn(record, ['credit']);
    const amount = parseAmount(amountRaw);
    if (!description.trim() || amount == null) {
      skippedRows += 1;
      continue;
    }
    if (isTotalRow(description, amount)) {
      skippedRows += 1;
      continue;
    }
    const currencyRaw = pickColumn(record, ['currency', 'curr']);
    const currency = currencyRaw ? (normalizeIso4217Code(currencyRaw) ?? defaultCode) : defaultCode;
    const category = normalizeCategory(pickColumn(record, ['category', 'type']));
    const date = normalizeDate(
      pickColumn(record, ['date', 'transactiondate', 'posted', 'time']),
      fallbackDate
    );

    rows.push({
      description: description.trim(),
      amount,
      currency,
      category,
      date,
    });
  }

  if (rows.length === 0) {
    throw new Error(
      'No expense rows found. Use columns like Date, Description, Amount (and optional Category, Currency).'
    );
  }

  return {
    format: 'csv',
    rows: capRows(rows, warnings),
    warnings,
    skippedRows,
  };
}

/** Parse lines extracted from ThoughtExpense PDF exports or similar plain-text tables. */
function parsePlainTextExpenseLines(text: string, defaultCurrency: string): ExpenseImportRow[] {
  const fallbackDate = new Date().toISOString().slice(0, 10);
  const defaultCode = normalizeIso4217Code(defaultCurrency) ?? 'USD';
  const rows: ExpenseImportRow[] = [];
  const isoDateRow =
    /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(Food|Transport|Rent|Utilities|Shopping|Entertainment|Healthcare|Education|Personal Care|Fees|Other)\s+([\d,]+\.?\d*)\s+([A-Z]{3})\s*$/i;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('date') ||
      lower.includes('thoughtexpense') ||
      lower.startsWith('generated:') ||
      lower.includes('total expense')
    ) {
      continue;
    }

    const m = trimmed.match(isoDateRow);
    if (m) {
      const amount = parseAmount(m[4]);
      if (amount == null) continue;
      rows.push({
        date: m[1],
        description: m[2].trim(),
        category: normalizeCategory(m[3]),
        amount,
        currency: normalizeIso4217Code(m[5]) ?? defaultCode,
      });
      continue;
    }
  }

  if (rows.length === 0) {
    // Loose: "description amount" or "date description amount"
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      const loose = trimmed.match(/^(\d{4}-\d{2}-\d{2})?\s*(.+?)\s+([\d,]+\.?\d*)$/);
      if (!loose) continue;
      const amount = parseAmount(loose[3]);
      if (amount == null) continue;
      const desc = loose[2].trim();
      if (desc.length < 2 || isTotalRow(desc, amount)) continue;
      rows.push({
        date: loose[1] ? normalizeDate(loose[1], fallbackDate) : fallbackDate,
        description: desc,
        amount,
        currency: defaultCode,
        category: 'Other',
      });
    }
  }

  return rows;
}

export async function parseExpenseImportPdf(
  buffer: Buffer,
  defaultCurrency: string
): Promise<ExpenseImportPreview> {
  const warnings: string[] = [];
  let text: string;
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    text = result.text ?? '';
  } finally {
    await parser.destroy().catch(() => undefined);
  }

  if (!text.trim()) {
    throw new Error(
      'Could not extract text from this PDF. Try exporting CSV from your bank or spreadsheet.'
    );
  }

  const rows = parsePlainTextExpenseLines(text, defaultCurrency);
  if (rows.length === 0) {
    throw new Error(
      'No expense rows recognized in this PDF. For best results, import CSV with Date, Description, and Amount columns.'
    );
  }

  return {
    format: 'pdf',
    rows: capRows(rows, warnings),
    warnings,
    skippedRows: 0,
  };
}

export async function parseExpenseImportFile(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  defaultCurrency: string
): Promise<ExpenseImportPreview> {
  const lower = filename.toLowerCase();
  const isCsv =
    mimeType.includes('csv') ||
    mimeType.includes('text/plain') ||
    mimeType.includes('spreadsheet') ||
    lower.endsWith('.csv');
  const isPdf = mimeType.includes('pdf') || lower.endsWith('.pdf');

  if (isCsv && !isPdf) {
    return parseExpenseImportCsv(buffer, defaultCurrency);
  }
  if (isPdf) {
    return parseExpenseImportPdf(buffer, defaultCurrency);
  }
  throw new Error('Upload a CSV or PDF file.');
}
