import { Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { sendPasswordResetOtpEmail } from '../services/email.service';
import multer from 'multer';
import crypto from 'crypto';
import { deleteUserVectors } from '../services/pinecone.service';
import { setCache, getCache, deleteCache, deleteCachePattern } from '../config/redis';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { logger } from '../config/logger';
import { uploadToSpace, deleteFromSpace } from '../utils/storage';
import { authUserSelect, formatAuthUser } from '../utils/authUser.util';
import { refreshStalePremium } from '../utils/subscription.util';
import { moderationBlockMessage, moderationStatus } from '../utils/userModeration.util';

// Generate JWT token
const generateToken = (userId: string, tokenVersion = 0): string => {
  const secret = process.env.JWT_SECRET as string;
  const options = {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  };

  return jwt.sign(
    { id: userId, ver: tokenVersion, purpose: 'access' },
    secret,
    options as SignOptions
  );
};

// Generate password reset token (1 hour expiry)
const generatePasswordResetToken = (userId: string, email: string): string => {
  const secret = process.env.JWT_SECRET as string;
  return jwt.sign({ id: userId, email, purpose: 'password_reset' }, secret, {
    expiresIn: '1h',
  } as SignOptions);
};

// @desc    Register a new user
// @route   POST /api/auth/signup
// @access  Public
function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export const signup = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const email = normalizeEmail(req.body?.email);
  const { password, name, currency } = req.body;

  if (!email) {
    return next(new AppError('Email is required', 400));
  }

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    return next(new AppError('User already exists with this email', 400));
  }

  // Hash password
  const salt = await bcrypt.genSalt(12);
  const hashedPassword = await bcrypt.hash(password, salt);

  // Create user
  const user = await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      name: name || null,
      currency: currency || 'USD',
    },
    select: authUserSelect,
  });

  // Generate token
  const token = generateToken(user.id, 0);

  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    data: {
      user: formatAuthUser(user),
      token,
    },
  });
});

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
export const login = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;

  if (!email || typeof password !== 'string') {
    return next(new AppError('Invalid email or password', 401));
  }

  // Find user
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    return next(new AppError('Invalid email or password', 401));
  }

  // Check password
  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (!isPasswordValid) {
    return next(new AppError('Invalid email or password', 401));
  }

  const mod = moderationStatus(user);
  if (mod !== 'active') {
    return next(new AppError(moderationBlockMessage(mod), 403));
  }

  const { password: _, tokenVersion, ...rest } = user;
  const token = generateToken(user.id, tokenVersion);
  const billing = await refreshStalePremium(user.id, {
    isPremium: rest.isPremium,
    premiumSince: rest.premiumSince,
    premiumUntil: rest.premiumUntil,
    subscriptionStatus: rest.subscriptionStatus,
    subscriptionProductId: rest.subscriptionProductId,
    subscriptionStore: rest.subscriptionStore,
  });

  res.json({
    success: true,
    message: 'Login successful',
    data: {
      user: formatAuthUser({
        id: rest.id,
        email: rest.email,
        name: rest.name,
        profilePicture: rest.profilePicture,
        currency: rest.currency,
        createdAt: rest.createdAt,
        ...billing,
      }),
      token,
    },
  });
});

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
export const getMe = asyncHandler(async (req: AuthRequest, res: Response) => {
  const row = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: authUserSelect,
  });
  if (!row) {
    throw new AppError('User no longer exists', 404);
  }
  const billing = await refreshStalePremium(row.id, {
    isPremium: row.isPremium,
    premiumSince: row.premiumSince,
    premiumUntil: row.premiumUntil,
    subscriptionStatus: row.subscriptionStatus,
    subscriptionProductId: row.subscriptionProductId,
    subscriptionStore: row.subscriptionStore,
  });
  res.json({
    success: true,
    data: {
      user: formatAuthUser({ ...row, ...billing }),
    },
  });
});

// Multer config for avatar upload (memory storage) - exported for routes
export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

// @desc    Update user profile (name, currency)
// @route   PATCH /api/auth/profile
// @access  Private
export const updateProfile = asyncHandler(
  async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { name, currency } = req.body;
    const userId = req.user!.id;

    const updateData: { name?: string | null; currency?: string } = {};
    if (name !== undefined) {
      updateData.name = (typeof name === 'string' && name.trim()) || null;
    }
    if (currency !== undefined && typeof currency === 'string' && currency.length === 3) {
      updateData.currency = currency.toUpperCase();
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: authUserSelect,
    });

    const billing = await refreshStalePremium(userId, {
      isPremium: user.isPremium,
      premiumSince: user.premiumSince,
      premiumUntil: user.premiumUntil,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionProductId: user.subscriptionProductId,
      subscriptionStore: user.subscriptionStore,
    });

    res.json({
      success: true,
      message: 'Profile updated',
      data: {
        user: formatAuthUser({ ...user, ...billing }),
      },
    });
  }
);

// @desc    Upload profile picture
// @route   POST /api/auth/profile/picture
// @access  Private
export const uploadProfilePicture = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id;
    const file = req.file as Express.Multer.File | undefined;

    if (!file || !file.buffer) {
      return next(new AppError('No image file provided', 400));
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { profilePicture: true },
    });

    // Upload to Spaces
    const storedPath = await uploadToSpace(file.buffer, file.mimetype, 'avatars');

    if (!storedPath) {
      return next(new AppError('Failed to upload image. Storage may not be configured.', 500));
    }

    // Delete old image from Spaces if exists
    if (currentUser?.profilePicture) {
      await deleteFromSpace(currentUser.profilePicture);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { profilePicture: storedPath },
      select: authUserSelect,
    });

    const billing = await refreshStalePremium(userId, {
      isPremium: user.isPremium,
      premiumSince: user.premiumSince,
      premiumUntil: user.premiumUntil,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionProductId: user.subscriptionProductId,
      subscriptionStore: user.subscriptionStore,
    });

    res.json({
      success: true,
      message: 'Profile picture updated',
      data: {
        user: formatAuthUser({ ...user, ...billing }),
      },
    });
  }
);

// @desc    Forgot password - send reset email
// @route   POST /api/auth/forgot-password
// @access  Public
export const forgotPassword = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const { email } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    // Always return success to prevent email enumeration
    const successMessage =
      'If an account exists with that email, you will receive a 6-digit reset code.';

    if (!user) {
      res.json({ success: true, message: successMessage });
      return;
    }

    // Generate a 6-digit OTP and store its hash for 10 minutes
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    await setCache(`pwd-otp:${user.email}`, { otpHash, attempts: 0 }, 600);

    const result = await sendPasswordResetOtpEmail(user.email, otp);

    if (!result.success) {
      return next(
        new AppError(result.error || 'Failed to send reset email. Please try again later.', 500)
      );
    }

    res.json({ success: true, message: successMessage });
  }
);

// @desc    Reset password with token
// @route   POST /api/auth/reset-password
// @access  Public
export const resetPassword = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const { token, password } = req.body;

    if (!token || !password) {
      return next(new AppError('Token and new password are required', 400));
    }

    if (password.length < 6) {
      return next(new AppError('Password must be at least 6 characters', 400));
    }

    const secret = process.env.JWT_SECRET as string;
    let decoded: { id: string; email: string; purpose?: string };

    try {
      decoded = jwt.verify(token, secret) as typeof decoded;
    } catch {
      return next(new AppError('Invalid or expired reset link. Please request a new one.', 400));
    }

    if (decoded.purpose !== 'password_reset') {
      return next(new AppError('Invalid reset token', 400));
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user || user.email !== decoded.email) {
      return next(new AppError('Invalid reset token', 400));
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    await prisma.user.update({
      where: { id: decoded.id },
      data: { password: hashedPassword, tokenVersion: { increment: 1 } },
    });

    res.json({
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.',
    });
  }
);

// @desc    Change password (authenticated user)
// @route   POST /api/auth/change-password
// @access  Private
export const changePassword = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return next(new AppError('Current password and new password are required', 400));
    }

    if (newPassword.length < 6) {
      return next(new AppError('New password must be at least 6 characters', 400));
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });

    if (!user) {
      return next(new AppError('User not found', 404));
    }

    const isCurrentValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentValid) {
      return next(new AppError('Current password is incorrect', 400));
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword, tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });

    const token = generateToken(userId, updated.tokenVersion);

    res.json({
      success: true,
      message: 'Password updated successfully.',
      data: { token },
    });
  }
);

// @desc    Verify password-reset OTP and exchange it for a reset token
// @route   POST /api/auth/verify-otp
// @access  Public
export const verifyResetOtp = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return next(new AppError('Email and code are required', 400));
    }

    const key = `pwd-otp:${email}`;
    const record = await getCache<{ otpHash: string; attempts: number }>(key);

    if (!record) {
      return next(new AppError('Invalid or expired code. Please request a new one.', 400));
    }

    if (record.attempts >= 5) {
      await deleteCache(key);
      return next(new AppError('Too many attempts. Please request a new code.', 429));
    }

    const otpHash = crypto.createHash('sha256').update(String(otp)).digest('hex');
    if (otpHash !== record.otpHash) {
      await setCache(key, { ...record, attempts: record.attempts + 1 }, 600);
      return next(new AppError('Invalid or expired code. Please request a new one.', 400));
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      await deleteCache(key);
      return next(new AppError('Invalid or expired code. Please request a new one.', 400));
    }

    await deleteCache(key);
    const resetToken = generatePasswordResetToken(user.id, user.email);

    res.json({
      success: true,
      data: { resetToken },
    });
  }
);

// @desc    Permanently delete the authenticated user's account and all data
// @route   DELETE /api/auth/account
// @access  Private
export const deleteAccount = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const { password } = req.body;
    const userId = req.user!.id;

    if (!password) {
      return next(new AppError('Password is required to delete your account', 400));
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return next(new AppError('User not found', 404));
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return next(new AppError('Incorrect password', 401));
    }

    // Best-effort cleanup of external data (vector index, stored avatar, caches)
    try {
      await deleteUserVectors(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Pinecone cleanup failed during account deletion');
    }
    if (user.profilePicture) {
      try {
        await deleteFromSpace(user.profilePicture);
      } catch (err) {
        logger.error({ err, userId }, 'Avatar cleanup failed during account deletion');
      }
    }
    try {
      await deleteCachePattern(`*${userId}*`);
    } catch (err) {
      logger.error({ err, userId }, 'Cache cleanup failed during account deletion');
    }

    // Delete the user row; related rows cascade (expenses, vectors, budgets, insights, mappings)
    await prisma.user.delete({ where: { id: userId } });

    res.json({
      success: true,
      message: 'Your account and all associated data have been permanently deleted.',
    });
  }
);
