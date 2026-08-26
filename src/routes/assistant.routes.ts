import express, { Router } from 'express';
import { body, query } from 'express-validator';
import { ask, whySpendingChanged, savingsPlan, search } from '../controllers/assistant.controller';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';

const router: Router = express.Router();

router.use(protect);

router.post(
  '/ask',
  [body('question').isString().trim().notEmpty().withMessage('Question is required')],
  validate,
  ask
);

router.post('/why', whySpendingChanged);

router.post(
  '/savings-plan',
  [body('targetAmount').isFloat({ gt: 0 }).withMessage('targetAmount must be a positive number')],
  validate,
  savingsPlan
);

router.get(
  '/search',
  [query('q').isString().trim().notEmpty().withMessage('Search query (q) is required')],
  validate,
  search
);

export default router;
