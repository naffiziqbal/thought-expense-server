import express from 'express';
import { body, query, param } from 'express-validator';
import {
  parseAndCreateExpenses,
  getExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  getCategorySummary,
  getSimilarExpenses
} from '../controllers/expense.controller';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';

const router = express.Router();

// All routes are protected
router.use(protect);

// Validation rules
const parseExpensesValidation = [
  body('rawInput')
    .notEmpty()
    .withMessage('Raw input is required')
    .isString()
    .withMessage('Raw input must be a string')
    .isLength({ max: 5000 })
    .withMessage('Input too long (max 5000 characters)')
];

const updateExpenseValidation = [
  body('description').optional().isString().trim(),
  body('amount').optional().isFloat({ min: 0 }).withMessage('Amount must be positive'),
  body('currency').optional().isLength({ min: 3, max: 3 }).withMessage('Currency must be 3-letter code'),
  body('category').optional().isString().trim(),
  body('date').optional().isISO8601().withMessage('Invalid date format')
];

const queryExpensesValidation = [
  query('startDate').optional().isISO8601().withMessage('Invalid start date'),
  query('endDate').optional().isISO8601().withMessage('Invalid end date'),
  query('category').optional().isString().trim(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('Offset must be non-negative')
];

// Routes
router.post('/parse', parseExpensesValidation, validate, parseAndCreateExpenses);
router.get('/', queryExpensesValidation, validate, getExpenses);
router.get('/summary', getCategorySummary);
router.get('/:id', param('id').isUUID(), validate, getExpenseById);
router.get('/:id/similar', param('id').isUUID(), validate, getSimilarExpenses);
router.patch('/:id', param('id').isUUID(), updateExpenseValidation, validate, updateExpense);
router.delete('/:id', param('id').isUUID(), validate, deleteExpense);

export default router;
