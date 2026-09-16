/**
 * Exchange rate service - fetches real-time rates from open.er-api.com (no API key required)
 * Rates update daily. Caches for 1 hour to respect rate limits.
 */

import { getCache, setCache } from '../config/redis';
import { logger } from '../config/logger';

const CACHE_KEY_PREFIX = 'exchange_rates:';
const CACHE_TTL = 3600; // 1 hour

interface ExchangeRatesResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
}

async function fetchRatesFromApi(baseCurrency: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(
      `https://open.er-api.com/v6/latest/${baseCurrency}`
    );
    const data = (await res.json()) as ExchangeRatesResponse;
    if (data.result === 'success' && data.rates) {
      return data.rates;
    }
    return null;
  } catch (err) {
    logger.error({ err }, 'Exchange rate API error');
    return null;
  }
}

/**
 * Get exchange rates for a base currency. Uses cache when available.
 */
export async function getExchangeRates(baseCurrency: string): Promise<Record<string, number>> {
  const cacheKey = `${CACHE_KEY_PREFIX}${baseCurrency}`;
  const cached = await getCache<Record<string, number>>(cacheKey);
  if (cached) return cached;

  const rates = await fetchRatesFromApi(baseCurrency);
  if (rates) {
    await setCache(cacheKey, rates, CACHE_TTL);
    return rates;
  }

  // Fallback: same currency = 1, others we don't know - return empty (caller will use 1)
  return { [baseCurrency]: 1 };
}

/**
 * Convert amount from one currency to another using live rates.
 */
export async function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string
): Promise<number> {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  if (from === to) return amount;

  const rates = await getExchangeRates(from);
  const toRate = rates[to];
  if (!toRate) {
    // Try fetching with to as base
    const ratesTo = await getExchangeRates(to);
    const fromRate = ratesTo[from];
    if (fromRate) {
      return amount / fromRate;
    }
    // Fallback: no conversion possible, return original
    logger.warn({ from, to }, 'No exchange rate, returning original amount');
    return amount;
  }

  return amount * toRate;
}

/**
 * Convert stored budget limits into a display currency, returning amounts in
 * the same order as the input. A null source currency means the row predates
 * currency tracking, so it is assumed to already be in the target currency and
 * passes through untouched.
 */
export async function convertLimitsToCurrency(
  limits: { limit: number; currency?: string | null }[],
  targetCurrency: string
): Promise<number[]> {
  if (limits.length === 0) return [];

  const converted = await convertAmountsToCurrency(
    limits.map((l) => ({ amount: l.limit, currency: l.currency || targetCurrency })),
    targetCurrency
  );
  return converted.map((c) => parseFloat(c.amount.toFixed(2)));
}

/**
 * Convert multiple amounts - more efficient (single API call per unique fromCurrency).
 */
export async function convertAmountsToCurrency<T extends { amount: number; currency: string }>(
  items: T[],
  targetCurrency: string
): Promise<(T & { amount: number; currency: string })[]> {
  const target = targetCurrency.toUpperCase();
  const byFromCurrency = new Map<string, T[]>();
  for (const item of items) {
    const from = item.currency.toUpperCase();
    if (!byFromCurrency.has(from)) {
      byFromCurrency.set(from, []);
    }
    byFromCurrency.get(from)!.push(item);
  }

  const rateCache = new Map<string, Record<string, number>>();
  for (const [from] of byFromCurrency) {
    if (!rateCache.has(from)) {
      rateCache.set(from, await getExchangeRates(from));
    }
  }

  return items.map((item) => {
    const from = item.currency.toUpperCase();
    if (from === target) {
      return { ...item, amount: item.amount, currency: target };
    }
    const rates = rateCache.get(from);
    const toRate = rates?.[target];
    if (!toRate) {
      return { ...item, amount: item.amount, currency: item.currency };
    }
    return {
      ...item,
      amount: parseFloat((item.amount * toRate).toFixed(2)),
      currency: target,
    };
  });
}
