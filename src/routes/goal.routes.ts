import express, { Router } from 'express';
import { body } from 'express-validator';
import {
  createGoal,
  getGoals,
  updateGoal,
  contributeToGoal,
  deleteGoal,
} from '../controllers/goal.controller';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';

const router: Router = express.Router();

router.use(protect);

router.post(
  '/',
  [
    body('name').isString().trim().notEmpty().withMessage('Goal name is required'),
    body('targetAmount').isFloat({ gt: 0 }).withMessage('targetAmount must be a positive number'),
  ],
  validate,
  createGoal
);

router.get('/', getGoals);
router.patch('/:id', updateGoal);
router.post(
  '/:id/contribute',
  [body('amount').isFloat().withMessage('amount is required')],
  validate,
  contributeToGoal
);
router.delete('/:id', deleteGoal);

export default router;
