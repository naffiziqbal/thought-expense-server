/** Zero code points of native-script digit blocks: Bengali, Devanagari, Arabic-Indic, Urdu/Persian */
const NATIVE_DIGIT_ZEROS = [0x09e6, 0x0966, 0x0660, 0x06f0];

/** Convert native-script digits to ASCII ("চা ৫০" → "চা 50") */
export function normalizeDigits(text: string): string {
  return text.replace(/[০-৯०-९٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const zero = NATIVE_DIGIT_ZEROS.find((z) => code >= z && code <= z + 9) ?? code;
    return String(code - zero);
  });
}

/** Parse an AI-returned amount that may be a number or a string like "৫০", "1,200" or "৳50" */
export function parseAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = normalizeDigits(String(value ?? '')).replace(/[^\d.]/g, '');
  return parseFloat(cleaned) || 0;
}
