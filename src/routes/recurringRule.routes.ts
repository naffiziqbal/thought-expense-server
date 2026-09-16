import express, { Router } from 'express';
import { body, param } from 'express-validator';
import {
  createRecurringRule,
  getRecurringRules,
  updateRecurringRule,
  deleteRecurringRule,
  runRecurringRule,
} from '../controllers/recurringRule.controller';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';

const router: Router = express.Router();

router.use(protect);

router.post(
  '/',
  [
    body('description').isString().trim().notEmpty().withMessage('Description is required'),
    body('amount').isFloat({ gt: 0 }).withMessage('amount must be a positive number'),
    body('category').optional().isString().trim(),
    body('currency').optional().isLength({ min: 3, max: 3 }),
    body('frequency').optional().isIn(['weekly', 'monthly']),
    body('dayOfMonth').optional().isInt({ min: 1, max: 31 }),
    body('dayOfWeek').optional().isInt({ min: 0, max: 6 }),
  ],
  validate,
  createRecurringRule
);

router.get('/', getRecurringRules);
router.patch('/:id', param('id').isUUID(), validate, updateRecurringRule);
router.delete('/:id', param('id').isUUID(), validate, deleteRecurringRule);
router.post('/:id/run', param('id').isUUID(), validate, runRecurringRule);

export default router;
