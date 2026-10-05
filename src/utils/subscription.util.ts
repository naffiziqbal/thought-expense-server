import prisma from '../config/prisma';

export type SubscriptionPlan = 'monthly' | 'yearly' | 'lifetime';
export type SubscriptionStatus = 'active' | 'cancelled' | 'grace' | 'expired';

export interface SubscriptionSummary {
  plan: SubscriptionPlan | null;
  planLabel: string | null;
  status: SubscriptionStatus | null;
  premiumSince: string | null;
  premiumUntil: string | null;
  productId: string | null;
  store: string | null;
  summaryLine: string | null;
}

export const billingFieldsSelect = {
  isPremium: true,
  premiumSince: true,
  premiumUntil: true,
  subscriptionStatus: true,
  subscriptionProductId: true,
  subscriptionStore: true,
} as const;

export type UserBillingSnapshot = {
  isPremium: boolean;
  premiumSince: Date | null;
  premiumUntil: Date | null;
  subscriptionStatus: string | null;
  subscriptionProductId: string | null;
  subscriptionStore: string | null;
};

function formatShortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function inferPlan(productId: string | null): SubscriptionPlan | null {
  if (!productId) return null;
  const id = productId.toLowerCase();
  if (id.includes('lifetime')) return 'lifetime';
  if (id.includes('yearly') || id.includes('annual')) return 'yearly';
  if (id.includes('monthly')) return 'monthly';
  return null;
}

const PLAN_LABELS: Record<SubscriptionPlan, string> = {
  monthly: 'Monthly',
  yearly: 'Yearly',
  lifetime: 'Lifetime',
};

function normalizeStatus(raw: string | null, isPremium: boolean): SubscriptionStatus | null {
  if (!raw && !isPremium) return null;
  const s = (raw ?? '').toLowerCase();
  if (s === 'active' || s === 'cancelled' || s === 'grace' || s === 'expired') {
    return s as SubscriptionStatus;
  }
  return isPremium ? 'active' : 'expired';
}

export function buildSubscriptionSummary(snapshot: UserBillingSnapshot): SubscriptionSummary {
  const plan = inferPlan(snapshot.subscriptionProductId);
  const planLabel = plan ? PLAN_LABELS[plan] : null;
  const status = normalizeStatus(snapshot.subscriptionStatus, snapshot.isPremium);

  let summaryLine: string | null = null;
  if (snapshot.isPremium) {
    const until = snapshot.premiumUntil ? formatShortDate(snapshot.premiumUntil) : null;
    if (plan === 'lifetime') {
      summaryLine = 'Lifetime · Yours forever';
    } else if (status === 'grace') {
      summaryLine = planLabel
        ? `${planLabel} · Payment issue — update in Google Play`
        : 'Payment issue — update in Google Play';
    } else if (status === 'cancelled' && until) {
      summaryLine = planLabel ? `${planLabel} · Active until ${until}` : `Active until ${until}`;
    } else if (until) {
      summaryLine = planLabel ? `${planLabel} · Renews ${until}` : `Renews ${until}`;
    } else if (planLabel) {
      summaryLine = `${planLabel} · Premium active`;
    } else {
      summaryLine = 'Premium active';
    }
  }

  return {
    plan,
    planLabel,
    status,
    premiumSince: snapshot.premiumSince?.toISOString() ?? null,
    premiumUntil: snapshot.premiumUntil?.toISOString() ?? null,
    productId: snapshot.subscriptionProductId,
    store: snapshot.subscriptionStore,
    summaryLine,
  };
}

/** Manual admin “lifetime” comps are stored as a far-future premiumUntil (not NULL). */
export const MANUAL_LIFETIME_YEARS = 100;

export function manualPremiumLifetimeUntil(from = new Date()): Date {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() + MANUAL_LIFETIME_YEARS);
  return d;
}

/** True when until is null (legacy) or ~100y manual lifetime. */
export function isEffectiveManualLifetime(until: Date | null | undefined): boolean {
  if (!until) return true;
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const yearsAhead = (until.getTime() - Date.now()) / msPerYear;
  return yearsAhead >= MANUAL_LIFETIME_YEARS - 1;
}

/** Clear premium when premiumUntil is in the past (same rule as GET /api/billing/status). */
export async function refreshStalePremium(
  userId: string,
  snapshot: UserBillingSnapshot
): Promise<UserBillingSnapshot> {
  if (snapshot.isPremium && snapshot.premiumUntil && snapshot.premiumUntil.getTime() < Date.now()) {
    return prisma.user.update({
      where: { id: userId },
      data: { isPremium: false, subscriptionStatus: 'expired' },
      select: billingFieldsSelect,
    });
  }
  return snapshot;
}

export const authUserSelect = {
  id: true,
  email: true,
  name: true,
  profilePicture: true,
  currency: true,
  createdAt: true,
  isPremium: true,
  premiumSince: true,
  premiumUntil: true,
  subscriptionStatus: true,
  subscriptionProductId: true,
  subscriptionStore: true,
} as const;

export type AuthUserRow = {
  id: string;
  email: string;
  name: string | null;
  profilePicture: string | null;
  currency: string;
  createdAt: Date;
} & UserBillingSnapshot;
