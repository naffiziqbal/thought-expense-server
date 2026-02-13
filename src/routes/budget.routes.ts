import express, { Router } from 'express';
import { body, param, query } from 'express-validator';
import {
  upsertBudget,
  getCurrentBudget,
  getBudgetHistory,
  deleteBudget,
  parseCategoryBudgetsHandler,
  upsertCategoryBudgets,
  getCurrentCategoryBudgets,
} from '../controllers/budget.controller';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';

const router: Router = express.Router();

router.use(protect);

const upsertBudgetValidation = [
  body('month').isInt({ min: 1, max: 12 }).withMessage('Month must be between 1 and 12'),
  body('year').isInt({ min: 2000, max: 2100 }).withMessage('Year is invalid'),
  body('total_limit').isFloat({ gt: 0 }).withMessage('total_limit must be greater than 0'),
];

router.post('/', upsertBudgetValidation, validate, upsertBudget);
router.get('/current', getCurrentBudget);
router.get(
  '/history',
  query('limit').optional().isInt({ min: 1, max: 24 }).withMessage('limit must be between 1 and 24'),
  validate,
  getBudgetHistory
);
router.delete('/:id', param('id').isUUID(), validate, deleteBudget);

// Category budgets
router.post(
  '/categories/parse',
  body('text').isString().isLength({ min: 3 }).withMessage('text is required'),
  validate,
  parseCategoryBudgetsHandler
);

router.post(
  '/categories',
  body('month').isInt({ min: 1, max: 12 }),
  body('year').isInt({ min: 2000, max: 2100 }),
  body('items').isArray({ min: 1 }),
  validate,
  upsertCategoryBudgets
);

router.get('/categories/current', getCurrentCategoryBudgets);

export default router;

