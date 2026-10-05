import cc from 'currency-codes';

/** ISO 4217 alpha-3 codes known to the `currency-codes` registry (sorted). */
export const ISO4217_CODES: readonly string[] = Object.freeze([...cc.codes()].sort());

/** Shown first in pickers before the full ISO list. */
export const POPULAR_ISO4217_CODES: readonly string[] = Object.freeze([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CHF',
  'CNY',
  'INR',
  'BDT',
  'PKR',
  'SGD',
  'HKD',
  'NZD',
  'SEK',
  'NOK',
  'DKK',
  'ZAR',
  'MXN',
  'BRL',
  'KRW',
  'AED',
  'SAR',
  'TRY',
  'PLN',
  'THB',
  'MYR',
  'IDR',
  'PHP',
  'VND',
]);

const FLAG_OVERRIDES: Record<string, string> = {
  EUR: '🇪🇺',
};

export type Iso4217Currency = {
  /** ISO 4217 alpha-3 */
  code: string;
  name: string;
  symbol: string;
  flag: string;
  /** Signup / compact selects */
  label: string;
};

const metadataCache = new Map<string, Map<string, Iso4217Currency>>();

function displayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' });
  } catch {
    return null;
  }
}

function currencySymbol(code: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0);
    const sym = parts.find((p) => p.type === 'currency')?.value?.trim();
    return sym && sym !== code ? sym : code;
  } catch {
    return code;
  }
}

function flagForCurrency(code: string, countries: string[]): string {
  if (FLAG_OVERRIDES[code]) return FLAG_OVERRIDES[code];
  const region = countries.find((c) => c.length === 2);
  if (!region) return '🌍';
  const upper = region.toUpperCase();
  return String.fromCodePoint(...upper.split('').map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

function buildMetadata(code: string, locale: string): Iso4217Currency | null {
  const record = cc.code(code);
  if (!record) return null;
  const names = displayNames(locale);
  const name = names?.of(code) ?? record.currency ?? code;
  const symbol = currencySymbol(code, locale);
  return {
    code,
    name,
    symbol,
    flag: flagForCurrency(code, record.countries ?? []),
    label: `${code} — ${name}`,
  };
}

/** Normalize user input to a valid ISO 4217 alpha-3 code, or null. */
export function normalizeIso4217Code(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return cc.code(code) ? code : null;
}

export function isIso4217Currency(code: string): boolean {
  return normalizeIso4217Code(code) !== null;
}

export function getIso4217Currency(code: string, locale = 'en'): Iso4217Currency | null {
  const normalized = normalizeIso4217Code(code);
  if (!normalized) return null;
  let byLocale = metadataCache.get(locale);
  if (!byLocale) {
    byLocale = new Map();
    metadataCache.set(locale, byLocale);
  }
  const cached = byLocale.get(normalized);
  if (cached) return cached;
  const built = buildMetadata(normalized, locale);
  if (built) byLocale.set(normalized, built);
  return built;
}

function listAllMetadata(locale: string): Iso4217Currency[] {
  return ISO4217_CODES.map((code) => getIso4217Currency(code, locale)).filter(
    (c): c is Iso4217Currency => c !== null
  );
}

const allListCache: Map<string, Iso4217Currency[]> = new Map();

/** Every ISO 4217 currency in the registry, sorted by code. */
export function listIso4217Currencies(locale = 'en'): Iso4217Currency[] {
  const hit = allListCache.get(locale);
  if (hit) return hit;
  const list = listAllMetadata(locale);
  allListCache.set(locale, list);
  return list;
}

/** Popular codes first, then the rest (each group sorted by code). */
export function listIso4217CurrenciesGrouped(locale = 'en'): {
  popular: Iso4217Currency[];
  all: Iso4217Currency[];
} {
  const all = listIso4217Currencies(locale);
  const popularSet = new Set<string>(POPULAR_ISO4217_CODES);
  const popular = POPULAR_ISO4217_CODES.map((code) => getIso4217Currency(code, locale)).filter(
    (c): c is Iso4217Currency => c !== null
  );
  const rest = all.filter((c) => !popularSet.has(c.code));
  return { popular, all: rest };
}

export function searchIso4217Currencies(query: string, locale = 'en'): Iso4217Currency[] {
  const q = query.trim().toLowerCase();
  if (!q) return listIso4217Currencies(locale);
  return listIso4217Currencies(locale).filter(
    (c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
  );
}
