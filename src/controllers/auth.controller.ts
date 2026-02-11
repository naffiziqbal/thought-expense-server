import { Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import multer from 'multer';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import {
  uploadToSpace,
  deleteFromSpace,
  getFullUrl,
} from '../utils/storage';

// Generate JWT token
const generateToken = (userId: string): string => {
  const secret = process.env.JWT_SECRET as string;
  const options = {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  };
  
  return jwt.sign({ id: userId }, secret, options as SignOptions);
};

// @desc    Register a new user
// @route   POST /api/auth/signup
// @access  Public
export const signup = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { email, password, name, currency } = req.body;

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email }
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
      currency: currency || 'USD'
    },
    select: {
      id: true,
      email: true,
      name: true,
      profilePicture: true,
      currency: true,
      createdAt: true
    }
  });

  // Generate token
  const token = generateToken(user.id);

  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    data: {
      user: {
        ...user,
        profilePictureUrl: user.profilePicture ? getFullUrl(user.profilePicture) : null,
      },
      token
    }
  });
});

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
export const login = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { email, password } = req.body;

  // Find user
  const user = await prisma.user.findUnique({
    where: { email }
  });

  if (!user) {
    return next(new AppError('Invalid email or password', 401));
  }

  // Check password
  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (!isPasswordValid) {
    return next(new AppError('Invalid email or password', 401));
  }

  // Generate token
  const token = generateToken(user.id);

  // Remove password from response
  const { password: _, profilePicture, ...rest } = user;
  const userWithoutPassword = {
    ...rest,
    profilePicture,
    profilePictureUrl: profilePicture ? getFullUrl(profilePicture) : null,
  };

  res.json({
    success: true,
    message: 'Login successful',
    data: {
      user: userWithoutPassword,
      token
    }
  });
});

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
export const getMe = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const userWithUrl = {
    ...user,
    profilePictureUrl: user.profilePicture ? getFullUrl(user.profilePicture) : null,
  };
  res.json({
    success: true,
    data: {
      user: userWithUrl
    }
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

// @desc    Update user profile (name)
// @route   PATCH /api/auth/profile
// @access  Private
export const updateProfile = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { name } = req.body;
  const userId = req.user!.id;

  const updateData =
    name !== undefined
      ? { name: (typeof name === 'string' && name.trim()) || null }
      : {};

  const user = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      email: true,
      name: true,
      profilePicture: true,
      currency: true,
      createdAt: true
    }
  });

  res.json({
    success: true,
    message: 'Profile updated',
    data: {
      user: {
        ...user,
        profilePictureUrl: user.profilePicture ? getFullUrl(user.profilePicture) : null,
      }
    }
  });
});

// @desc    Upload profile picture
// @route   POST /api/auth/profile/picture
// @access  Private
export const uploadProfilePicture = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const file = req.file as Express.Multer.File | undefined;

  if (!file || !file.buffer) {
    return next(new AppError('No image file provided', 400));
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { profilePicture: true }
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
    select: {
      id: true,
      email: true,
      name: true,
      profilePicture: true,
      currency: true,
      createdAt: true
    }
  });

  res.json({
    success: true,
    message: 'Profile picture updated',
    data: {
      user: {
        ...user,
        profilePictureUrl: getFullUrl(user.profilePicture),
      }
    }
  });
});
