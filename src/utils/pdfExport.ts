import PDFDocument from 'pdfkit';
import type { Expense } from '@prisma/client';

export async function createPdf(
  expenses: Expense[],
  currency: string,
  dateStr: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('ThoughtExpense - Export', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Generated: ${dateStr}`, { align: 'center' });
    doc.moveDown(1.5);

    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    doc.fontSize(12).text(`Total: ${currency} ${total.toFixed(2)}`, { align: 'right' });
    doc.moveDown(1);

    const colWidths = [80, 120, 80, 60, 50];
    const startX = 50;
    let y = doc.y;

    // Header row
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Date', startX, y);
    doc.text('Description', startX + colWidths[0], y);
    doc.text('Category', startX + colWidths[0] + colWidths[1], y);
    doc.text('Amount', startX + colWidths[0] + colWidths[1] + colWidths[2], y);
    doc.text('Currency', startX + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3], y);
    y += 15;
    doc.moveTo(50, y).lineTo(545, y).stroke();
    y += 5;

    doc.font('Helvetica').fontSize(9);
    for (const e of expenses) {
      if (y > 750) {
        doc.addPage();
        y = 50;
      }
      doc.text(e.date.toISOString().slice(0, 10), startX, y);
      doc.text((e.description || '').slice(0, 25), startX + colWidths[0], y);
      doc.text(e.category, startX + colWidths[0] + colWidths[1], y);
      doc.text(e.amount.toFixed(2), startX + colWidths[0] + colWidths[1] + colWidths[2], y);
      doc.text(e.currency, startX + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3], y);
      y += 12;
    }

    doc.end();
  });
}
