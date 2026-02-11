import express, { Router } from 'express';
import { body } from 'express-validator';
import {
  signup,
  login,
  getMe,
  updateProfile,
  uploadProfilePicture,
  avatarUpload,
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
];

// Routes
router.post('/signup', signupValidation, validate, signup);
router.post('/login', loginValidation, validate, login);
router.get('/me', protect, getMe);
router.patch('/profile', protect, updateProfileValidation, validate, updateProfile);
router.post('/profile/picture', protect, avatarUpload.single('image'), uploadProfilePicture);

export default router;
