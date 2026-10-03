import express, { Router } from 'express';
import { protectAdmin } from '../middleware/adminAuth.middleware';
import { adminLogin, adminMe } from '../controllers/adminAuth.controller';
import {
  getAiUsage,
  getAuditLogs,
  getBillingDrift,
  getBillingEvents,
  getGrowth,
  getQueueMonitor,
  getRagHealth,
  getRevenueCatSync,
  getStatsOverview,
  getSystemHealth,
  getUser,
  getUsers,
  patchUser,
  postReconcileStalePremium,
  postRevokeUserSessions,
} from '../controllers/admin.controller';

const router: Router = express.Router();

router.post('/auth/login', adminLogin);
router.get('/auth/me', protectAdmin, adminMe);

router.use(protectAdmin);

router.get('/stats/overview', getStatsOverview);
router.get('/growth', getGrowth);
router.get('/users', getUsers);
router.get('/users/:id', getUser);
router.patch('/users/:id', patchUser);
router.post('/users/:id/revoke-sessions', postRevokeUserSessions);
router.get('/billing/events', getBillingEvents);
router.get('/billing/drift', getBillingDrift);
router.post('/billing/reconcile-stale', postReconcileStalePremium);
router.get('/audit', getAuditLogs);
router.get('/system/health', getSystemHealth);
router.get('/ai/usage', getAiUsage);
router.get('/queues', getQueueMonitor);
router.get('/rag/health', getRagHealth);
router.get('/integrations/revenuecat', getRevenueCatSync);

export default router;
