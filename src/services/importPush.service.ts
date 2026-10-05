import { sendPushToUser } from './push.service';

export function notifyDocumentImportComplete(
  userId: string,
  opts: { fileName?: string | null; importedCount: number }
): void {
  const { fileName, importedCount } = opts;
  const shortName = fileName && fileName.length > 40 ? `${fileName.slice(0, 37)}…` : fileName;

  const title = importedCount > 0 ? 'Import complete' : 'Import finished';
  const body =
    importedCount > 0
      ? `Added ${importedCount} expense${importedCount === 1 ? '' : 's'}${shortName ? ` from ${shortName}` : ''}. Tap to review in Expenses.`
      : `No expenses were saved${shortName ? ` from ${shortName}` : ''}. Try a CSV export or a clearer scan.`;

  void sendPushToUser(userId, {
    title,
    body,
    data: { screen: 'expenses' },
  });
}
