import express, { Router } from 'express';
import { revenuecatWebhook, getBillingStatus } from '../controllers/billing.controller';
import { protect } from '../middleware/auth.middleware';

const router: Router = express.Router();

// Webhook is authenticated by the shared Authorization header, not JWT
router.post('/revenuecat', revenuecatWebhook);
router.get('/status', protect, getBillingStatus);

export default router;
