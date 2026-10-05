export type AccountModerationStatus = 'active' | 'suspended' | 'banned';

export function moderationStatus(user: {
  suspendedAt: Date | null;
  bannedAt: Date | null;
}): AccountModerationStatus {
  if (user.bannedAt) return 'banned';
  if (user.suspendedAt) return 'suspended';
  return 'active';
}

export function moderationBlockMessage(status: AccountModerationStatus): string {
  if (status === 'banned') {
    return 'This account has been permanently banned. Contact support if you believe this is an error.';
  }
  if (status === 'suspended') {
    return 'This account is suspended. Contact support for assistance.';
  }
  return '';
}
