/**
 * Gemini list prices (paid tier, USD per 1M tokens) used to estimate per-user AI cost.
 * Source: https://ai.google.dev/gemini-api/docs/pricing (checked 2026-10-08).
 * Thinking tokens are billed as output. Free-tier usage is billed $0 by Google,
 * so these numbers are what the traffic *would* cost on the paid tier.
 *
 * Override or extend without a deploy via AI_PRICING_JSON, e.g.
 *   AI_PRICING_JSON='{"gemini-2.5-flash":{"input":0.3,"output":2.5}}'
 */
export interface ModelPrice {
  /** USD per 1M input (prompt) tokens */
  input: number;
  /** USD per 1M output tokens (candidates + thinking) */
  output: number;
}

const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-3.5-flash': { input: 1.5, output: 9 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3-flash-preview': { input: 0.5, output: 3 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  // Currently served by gemini-3.5-flash-lite.
  'gemini-flash-lite-latest': { input: 0.3, output: 2.5 },
  // Alias that tracks the newest Flash release — priced like the current 3.x Flash.
  'gemini-flash-latest': { input: 0.75, output: 3.75 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
};

/** Used when a model isn't in the table (priced high on purpose so it isn't under-counted). */
const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 1.5, output: 9 };

function loadPricing(): Record<string, ModelPrice> {
  const raw = process.env.AI_PRICING_JSON;
  if (!raw) return DEFAULT_PRICING;
  try {
    return { ...DEFAULT_PRICING, ...(JSON.parse(raw) as Record<string, ModelPrice>) };
  } catch {
    return DEFAULT_PRICING;
  }
}

export const AI_PRICING = loadPricing();

export function normalizeModelName(model: string): string {
  return model.replace(/^models\//, '').trim() || 'unknown';
}

export function priceForModel(model: string): ModelPrice & { known: boolean } {
  const name = normalizeModelName(model);
  const exact = AI_PRICING[name];
  if (exact) return { ...exact, known: true };
  // Dated/preview variants, e.g. gemini-2.5-flash-preview-05-20 → gemini-2.5-flash
  const prefix = Object.keys(AI_PRICING)
    .filter((k) => name.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return { ...AI_PRICING[prefix], known: true };
  return { ...UNKNOWN_MODEL_PRICE, known: false };
}

/** Cost in nano-USD (1e-9 USD) so it can be stored with integer HINCRBY without losing tiny calls. */
export function costNanoUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceForModel(model);
  // price is USD per 1M tokens → nano-USD per token is `price * 1000`
  return Math.round((inputTokens * p.input + outputTokens * p.output) * 1000);
}

export const NANO_USD = 1e9;
