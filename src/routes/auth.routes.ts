import express, { Router } from 'express';
import { body } from 'express-validator';
import { forgotPasswordLimiter, otpVerifyLimiter } from '../middleware/rateLimit';
import {
  signup,
  login,
  getMe,
  updateProfile,
  uploadProfilePicture,
  avatarUpload,
  forgotPassword,
  resetPassword,
  changePassword,
  verifyResetOtp,
  deleteAccount,
} from '../controllers/auth.controller';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';

const router: Router = express.Router();

// Validation rules
const signupValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('name').optional().trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('currency').optional().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter code')
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('password').notEmpty().withMessage('Password is required')
];

const updateProfileValidation = [
  body('name').optional().trim().isLength({ min: 1, max: 100 }).withMessage('Name must be 1-100 characters'),
  body('currency').optional().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter code'),
];

const forgotPasswordValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
];

const resetPasswordValidation = [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

const verifyOtpValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('otp').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Code must be 6 digits'),
];

const deleteAccountValidation = [
  body('password').notEmpty().withMessage('Password is required'),
];

const changePasswordValidation = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
];

// Routes
router.post('/signup', signupValidation, validate, signup);
router.post('/login', loginValidation, validate, login);
router.get('/me', protect, getMe);
router.patch('/profile', protect, updateProfileValidation, validate, updateProfile);
router.post('/profile/picture', protect, avatarUpload.single('image'), uploadProfilePicture);
router.post('/forgot-password', forgotPasswordLimiter, forgotPasswordValidation, validate, forgotPassword);
router.post('/verify-otp', otpVerifyLimiter, verifyOtpValidation, validate, verifyResetOtp);
router.post('/reset-password', resetPasswordValidation, validate, resetPassword);
router.post('/change-password', protect, changePasswordValidation, validate, changePassword);
router.delete('/account', protect, deleteAccountValidation, validate, deleteAccount);

export default router;
