import express, { Router } from 'express';
import { body } from 'express-validator';
import { upsertBudget, getCurrentBudget } from '../controllers/budget.controller';
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

export default router;

