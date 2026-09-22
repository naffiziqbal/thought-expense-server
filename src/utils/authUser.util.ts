import { getFullUrl } from './storage';
import {
  buildSubscriptionSummary,
  type AuthUserRow,
  type UserBillingSnapshot,
} from './subscription.util';

export function formatAuthUser(user: AuthUserRow) {
  const billing: UserBillingSnapshot = {
    isPremium: user.isPremium,
    premiumSince: user.premiumSince,
    premiumUntil: user.premiumUntil,
    subscriptionStatus: user.subscriptionStatus,
    subscriptionProductId: user.subscriptionProductId,
    subscriptionStore: user.subscriptionStore,
  };

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    profilePicture: user.profilePicture,
    profilePictureUrl: user.profilePicture ? getFullUrl(user.profilePicture) : null,
    currency: user.currency,
    isPremium: user.isPremium,
    createdAt: user.createdAt,
    subscription: buildSubscriptionSummary(billing),
  };
}

export { authUserSelect } from './subscription.util';
