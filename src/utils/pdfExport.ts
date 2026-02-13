import PDFDocument from 'pdfkit';
import type { Expense } from '@prisma/client';

const MARGIN = 50;
const PAGE_WIDTH = 595;
const TABLE_LEFT = MARGIN;
const TABLE_RIGHT = PAGE_WIDTH - MARGIN;

function drawTableRow(
  doc: PDFKit.PDFDocument,
  y: number,
  cells: string[],
  colWidths: number[],
  isHeader: boolean,
  isTotal?: boolean
): number {
  const startX = TABLE_LEFT;
  let x = startX;

  if (isHeader || isTotal) doc.font('Helvetica-Bold');
  else doc.font('Helvetica');

  doc.fontSize(9);
  for (let i = 0; i < cells.length; i++) {
    const cellText = (cells[i] || '').slice(0, i === 1 ? 30 : 15);
    doc.text(cellText, x + 4, y + 4, { width: colWidths[i] - 8 });
    x += colWidths[i];
  }

  // Draw cell borders
  x = startX;
  for (let i = 0; i < colWidths.length; i++) {
    doc.rect(x, y, colWidths[i], 20).stroke();
    x += colWidths[i];
  }

  return y + 20;
}

export async function createPdf(
  expenses: Expense[],
  currency: string,
  dateStr: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('ThoughtExpense - Export', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Generated: ${dateStr}`, { align: 'center' });
    doc.moveDown(1.5);

    const colWidths = [70, 180, 100, 80, 55];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    let y = doc.y;

    // Table header
    y = drawTableRow(doc, y, ['Date', 'Description', 'Category', 'Amount', 'Currency'], colWidths, true);
    doc.font('Helvetica');

    // Data rows
    for (const e of expenses) {
      if (y > 720) {
        doc.addPage();
        y = 50;
      }
      y = drawTableRow(
        doc,
        y,
        [
          e.date.toISOString().slice(0, 10),
          e.description || '',
          e.category,
          e.amount.toFixed(2),
          e.currency,
        ],
        colWidths,
        false
      );
    }

    // Total row
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    if (y > 720) {
      doc.addPage();
      y = 50;
    }
    y = drawTableRow(doc, y, ['', 'Total Expense', '', total.toFixed(2), currency], colWidths, false, true);

    doc.end();
  });
}
