import prisma from '../config/prisma';
import { getUserDetail } from './admin.service';
import { moderationStatus } from '../utils/userModeration.util';

export type ModerationAction = 'suspend' | 'ban' | 'reactivate';

export async function applyUserModeration(
  userId: string,
  action: ModerationAction,
  note?: string | null
) {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true, bannedAt: true },
  });
  if (!existing) return null;

  const status = moderationStatus(existing);
  const now = new Date();
  const trimmedNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null;

  if (action === 'suspend') {
    if (status === 'banned') {
      throw new Error('USER_BANNED');
    }
    if (status === 'suspended') {
      throw new Error('ALREADY_SUSPENDED');
    }
    await prisma.user.update({
      where: { id: userId },
      data: {
        suspendedAt: now,
        moderationNote: trimmedNote,
        tokenVersion: { increment: 1 },
      },
    });
  } else if (action === 'ban') {
    if (status === 'banned') {
      throw new Error('ALREADY_BANNED');
    }
    await prisma.user.update({
      where: { id: userId },
      data: {
        bannedAt: now,
        suspendedAt: null,
        moderationNote: trimmedNote,
        tokenVersion: { increment: 1 },
      },
    });
  } else {
    if (status === 'active') {
      throw new Error('ALREADY_ACTIVE');
    }
    await prisma.user.update({
      where: { id: userId },
      data: {
        suspendedAt: null,
        bannedAt: null,
        moderationNote: null,
      },
    });
  }

  return getUserDetail(userId);
}
