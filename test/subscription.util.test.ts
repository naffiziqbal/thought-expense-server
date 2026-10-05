import { describe, expect, it } from 'vitest';
import {
  buildSubscriptionSummary,
  isEffectiveManualLifetime,
  manualPremiumLifetimeUntil,
  MANUAL_LIFETIME_YEARS,
} from '../src/utils/subscription.util';

describe('buildSubscriptionSummary', () => {
  it('returns null summary for free users', () => {
    const summary = buildSubscriptionSummary({
      isPremium: false,
      premiumSince: null,
      premiumUntil: null,
      subscriptionStatus: null,
      subscriptionProductId: null,
      subscriptionStore: null,
    });
    expect(summary.plan).toBeNull();
    expect(summary.summaryLine).toBeNull();
  });

  it('describes an active yearly plan', () => {
    const until = new Date('2026-04-01T00:00:00.000Z');
    const summary = buildSubscriptionSummary({
      isPremium: true,
      premiumSince: new Date('2026-01-01T00:00:00.000Z'),
      premiumUntil: until,
      subscriptionStatus: 'active',
      subscriptionProductId: 'thoughtexpense_premium_yearly',
      subscriptionStore: 'play_store',
    });
    expect(summary.plan).toBe('yearly');
    expect(summary.planLabel).toBe('Yearly');
    expect(summary.summaryLine).toMatch(/Yearly · Renews/);
  });

  it('describes lifetime access', () => {
    const summary = buildSubscriptionSummary({
      isPremium: true,
      premiumSince: new Date(),
      premiumUntil: null,
      subscriptionStatus: 'active',
      subscriptionProductId: 'thoughtexpense_premium_lifetime',
      subscriptionStore: 'play_store',
    });
    expect(summary.plan).toBe('lifetime');
    expect(summary.summaryLine).toBe('Lifetime · Yours forever');
  });
});

describe('manualPremiumLifetimeUntil', () => {
  it('adds 100 years for admin lifetime comps', () => {
    const from = new Date('2026-01-15T12:00:00.000Z');
    const until = manualPremiumLifetimeUntil(from);
    expect(until.getUTCFullYear()).toBe(from.getUTCFullYear() + MANUAL_LIFETIME_YEARS);
    expect(isEffectiveManualLifetime(until)).toBe(true);
  });
});
