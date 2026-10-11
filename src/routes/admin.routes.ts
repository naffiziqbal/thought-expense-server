import express, { Router } from 'express';
import { protectAdmin } from '../middleware/adminAuth.middleware';
import {
  adminLogin,
  adminLogout,
  adminLogoutAll,
  adminMe,
  adminRefresh,
} from '../controllers/adminAuth.controller';
import { loginLimiter } from '../middleware/rateLimit';
import {
  getAiUsage,
  getTopAiUsersHandler,
  getUserAiUsage,
  getAuditLogs,
  getBillingDrift,
  getBillingEvents,
  getGrowth,
  getQueueMonitor,
  getRagHealth,
  getRevenueCatSync,
  getStatsOverview,
  getSystemBackups,
  getSystemHealth,
  postBackupDownloadLink,
  postTestAlert,
  getUser,
  getUsers,
  patchUser,
  postReconcileStalePremium,
  postRevokeUserSessions,
  postUserModeration,
} from '../controllers/admin.controller';

const router: Router = express.Router();

router.post('/auth/login', loginLimiter, adminLogin);
router.post('/auth/refresh', loginLimiter, adminRefresh);
router.post('/auth/logout', adminLogout);
router.get('/auth/me', protectAdmin, adminMe);
router.post('/auth/logout-all', protectAdmin, adminLogoutAll);

router.use(protectAdmin);

router.get('/stats/overview', getStatsOverview);
router.get('/growth', getGrowth);
router.get('/users', getUsers);
router.get('/users/:id/ai-usage', getUserAiUsage);
router.get('/users/:id', getUser);
router.patch('/users/:id', patchUser);
router.post('/users/:id/moderation', postUserModeration);
router.post('/users/:id/revoke-sessions', postRevokeUserSessions);
router.get('/billing/events', getBillingEvents);
router.get('/billing/drift', getBillingDrift);
router.post('/billing/reconcile-stale', postReconcileStalePremium);
router.get('/audit', getAuditLogs);
router.get('/system/health', getSystemHealth);
router.get('/system/backups', getSystemBackups);
router.post('/system/backups/link', postBackupDownloadLink);
router.post('/system/alerts/test', postTestAlert);
router.get('/ai/usage', getAiUsage);
router.get('/ai/top-users', getTopAiUsersHandler);
router.get('/queues', getQueueMonitor);
router.get('/rag/health', getRagHealth);
router.get('/integrations/revenuecat', getRevenueCatSync);

export default router;
