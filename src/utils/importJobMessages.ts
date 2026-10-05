export type ImportJobPhase = 'queued' | 'ocr' | 'parse' | 'save' | 'done' | 'failed' | 'cancelled';

export function importJobPhase(progress: number, status: string): ImportJobPhase {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'done';
  if (status === 'waiting' || status === 'delayed' || status === 'prioritized') return 'queued';
  // Job is running but progress not bumped yet (loading large payload from Redis).
  if (progress < 18) return 'ocr';
  if (progress < 45) return 'ocr';
  if (progress < 75) return 'parse';
  return 'save';
}

export function importJobUserMessage(opts: {
  progress: number;
  status: string;
  importFileName?: string | null;
  error?: string | null;
  importedCount?: number;
}): string {
  const { progress, status, importFileName, error, importedCount } = opts;
  const name = importFileName ? `"${importFileName}"` : 'your file';

  if (status === 'cancelled') {
    return 'Import cancelled. Nothing new was added from this file.';
  }
  if (status === 'failed') {
    return error || 'Import failed. Try CSV export from your bank or a clearer photo.';
  }
  if (status === 'completed') {
    const n = importedCount ?? 0;
    return n > 0
      ? `Added ${n} expense${n === 1 ? '' : 's'} from ${name}. Open Expenses to review.`
      : `Import finished, but no expenses were saved from ${name}.`;
  }

  const phase = importJobPhase(progress, status);
  switch (phase) {
    case 'queued':
      if (status === 'waiting' || status === 'delayed' || status === 'prioritized') {
        return `In line to start — the server processes one expense job at a time. ${name} is next when the current job finishes.`;
      }
      return `Got ${name}. Starting import…`;
    case 'ocr':
      if (progress < 18) {
        return 'Starting on your document — loading the file and preparing OCR.';
      }
      return 'Reading your document — extracting text from each page (OCR).';
    case 'parse':
      return 'AI is finding dates, amounts, and categories in what we read.';
    case 'save':
      return 'Saving transactions to your expense list…';
    default:
      return 'Working on your import…';
  }
}
