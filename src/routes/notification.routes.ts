import express, { Router } from 'express';
import { body } from 'express-validator';
import {
  registerDevice,
  unregisterDevice,
  getPreferences,
  updatePreferences,
  sendTestPush,
} from '../controllers/notification.controller';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';

const router: Router = express.Router();

router.use(protect);

router.post(
  '/register',
  [body('token').isString().trim().notEmpty().withMessage('Push token is required')],
  validate,
  registerDevice
);

router.post(
  '/unregister',
  [body('token').isString().trim().notEmpty().withMessage('Push token is required')],
  validate,
  unregisterDevice
);

router.get('/preferences', getPreferences);
router.patch('/preferences', updatePreferences);
router.post('/test', sendTestPush);

export default router;
