import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  replies: [] as string[],
  calls: [] as Array<{ params: Record<string, unknown>; contents: unknown }>,
  usage: { promptTokenCount: 2000, candidatesTokenCount: 100, cachedContentTokenCount: 1500 },
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel(params: Record<string, unknown>) {
      return {
        model: `models/${params.model}`,
        generateContent: async (contents: unknown) => {
          state.calls.push({ params, contents });
          const text = state.replies.shift() ?? '[]';
          return { response: { text: () => text, usageMetadata: state.usage } };
        },
      };
    }
  },
}));

vi.mock('../src/config/redis', () => ({
  getCache: async (key: string) => {
    const raw = state.store.get(key);
    return raw ? JSON.parse(raw) : null;
  },
  setCache: async (key: string, value: unknown) => {
    state.store.set(key, JSON.stringify(value));
  },
}));

const metrics = vi.hoisted(() => ({
  recordAiCacheHit: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
  recordUserAiUsage: vi.fn(async () => {}),
  recordAiFallback: vi.fn(async () => {}),
}));
vi.mock('../src/services/aiMetrics.service', () => metrics);

import { costNanoUsd } from '../src/config/aiPricing';
import { aiResponseCacheKey } from '../src/services/aiCache.service';
import { parseCategoryBudgets, parseExpenses } from '../src/services/gemini.service';

beforeEach(() => {
  state.store.clear();
  state.replies = [];
  state.calls = [];
  vi.clearAllMocks();
  delete process.env.AI_RESPONSE_CACHE;
});

describe('costNanoUsd', () => {
  it('bills cached prompt tokens at 10% of the input price', () => {
    // gemini-2.5-flash: $0.30/M input, $2.50/M output
    expect(costNanoUsd('gemini-2.5-flash', 1000, 0)).toBe(300_000);
    expect(costNanoUsd('gemini-2.5-flash', 1000, 0, 1000)).toBe(30_000);
    expect(costNanoUsd('gemini-2.5-flash', 1000, 100, 600)).toBe(400 * 300 + 600 * 30 + 100 * 2500);
  });

  it('never counts more cached tokens than input tokens', () => {
    expect(costNanoUsd('gemini-2.5-flash', 100, 0, 500)).toBe(
      costNanoUsd('gemini-2.5-flash', 100, 0, 100)
    );
  });
});

describe('aiResponseCacheKey', () => {
  it('changes with instructions, text and file bytes', () => {
    const base = aiResponseCacheKey('ocr', 'sys', [
      { inlineData: { data: 'AAA', mimeType: 'image/png' } },
      'p',
    ]);
    expect(
      aiResponseCacheKey('ocr', 'sys', [
        { inlineData: { data: 'AAA', mimeType: 'image/png' } },
        'p',
      ])
    ).toBe(base);
    expect(
      aiResponseCacheKey('ocr', 'sys', [
        { inlineData: { data: 'AAB', mimeType: 'image/png' } },
        'p',
      ])
    ).not.toBe(base);
    expect(
      aiResponseCacheKey('ocr', 'sys2', [
        { inlineData: { data: 'AAA', mimeType: 'image/png' } },
        'p',
      ])
    ).not.toBe(base);
    expect(
      aiResponseCacheKey('parse', 'sys', [
        { inlineData: { data: 'AAA', mimeType: 'image/png' } },
        'p',
      ])
    ).not.toBe(base);
  });
});

describe('Gemini response cache', () => {
  const reply = JSON.stringify([
    {
      description: 'zzqx widget',
      amount: 120,
      currency: 'BDT',
      category: 'Gadgets',
      confidence: 0.9,
      date: '2026-10-18',
    },
  ]);

  it('answers an identical parse from Redis without calling the model again', async () => {
    state.replies = [reply];
    const first = await parseExpenses('zzqx widget 120', 'BDT', [], '2026-10-18', 'parse', 'u1');
    const second = await parseExpenses(
      'zzqx widget 120',
      'BDT',
      [],
      '2026-10-18',
      'parse_async',
      'u1'
    );

    expect(state.calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(metrics.recordAiCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.recordAiCacheHit).toHaveBeenCalledWith('parse_async', expect.any(Number));
  });

  it('sends static rules as systemInstruction and asks for JSON', async () => {
    state.replies = [reply];
    await parseExpenses('zzqx widget 120', 'BDT', [], '2026-10-18', 'parse', 'u1');
    const { params, contents } = state.calls[0];
    expect(params.systemInstruction).toContain('expense parsing assistant');
    expect(params.systemInstruction).not.toContain('2026-10-18');
    expect(params.generationConfig).toEqual({ responseMimeType: 'application/json' });
    expect(String(contents)).toContain('2026-10-18');
  });

  it('misses when the date or category history changes', async () => {
    state.replies = [reply, reply, reply];
    await parseExpenses('zzqx widget 120', 'BDT', [], '2026-10-18', 'parse', 'u1');
    await parseExpenses('zzqx widget 120', 'BDT', [], '2026-10-17', 'parse', 'u1');
    await parseExpenses(
      'zzqx widget 120',
      'BDT',
      [{ keyword: 'zzqx', category: 'Toys' }],
      '2026-10-18',
      'parse',
      'u1'
    );
    expect(state.calls).toHaveLength(3);
  });

  it('does not cache a reply that is not valid JSON', async () => {
    state.replies = ['not json at all', JSON.stringify([{ category: 'Food', limit: 500 }])];
    await expect(parseCategoryBudgets('food 500', [], 'u1')).rejects.toThrow();
    const items = await parseCategoryBudgets('food 500', [], 'u1');
    expect(items).toEqual([{ category: 'Food', limit: 500 }]);
    expect(state.calls).toHaveLength(2);
  });

  it('records cached prompt tokens from usage metadata', async () => {
    state.replies = [reply];
    await parseExpenses('zzqx widget 120', 'BDT', [], '2026-10-18', 'parse', 'u1');
    expect(metrics.recordUserAiUsage).toHaveBeenCalledWith(
      'u1',
      'parse',
      expect.objectContaining({ inputTokens: 2000, cachedInputTokens: 1500 })
    );
  });

  it('can be switched off with AI_RESPONSE_CACHE=off', async () => {
    process.env.AI_RESPONSE_CACHE = 'off';
    state.replies = [reply, reply];
    await parseExpenses('zzqx widget 120', 'BDT', [], '2026-10-18', 'parse', 'u1');
    await parseExpenses('zzqx widget 120', 'BDT', [], '2026-10-18', 'parse', 'u1');
    expect(state.calls).toHaveLength(2);
  });
});
