import express from 'express';
import { query } from 'express-validator';
import {
  generateWeeklyInsights,
  getInsights
} from '../controllers/insight.controller';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';

const router = express.Router();

// All routes are protected
router.use(protect);

// Validation rules
const getInsightsValidation = [
  query('type').optional().isIn(['weekly', 'monthly', 'trend']).withMessage('Invalid insight type'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be 1-50')
];

// Routes
router.post('/generate', generateWeeklyInsights);
router.get('/', getInsightsValidation, validate, getInsights);

export default router;
