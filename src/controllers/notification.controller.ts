import { Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { asyncHandler, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { sendPushToUser } from '../services/push.service';

const VALID_PLATFORMS = ['ios', 'android'];

// @desc    Register this device for push notifications
// @route   POST /api/notifications/register
// @access  Private
export const registerDevice = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id;
    const { token, platform } = req.body;

    if (!token || typeof token !== 'string') {
      return next(new AppError('A push token is required', 400));
    }

    const devicePlatform = VALID_PLATFORMS.includes(platform) ? platform : 'android';

    // A token is globally unique but can move between users on shared devices.
    await prisma.deviceToken.upsert({
      where: { token },
      update: { userId, platform: devicePlatform },
      create: { userId, token, platform: devicePlatform },
    });

    res.json({ success: true, message: 'Device registered' });
  }
);

// @desc    Stop pushes to this device (logout / toggle off)
// @route   POST /api/notifications/unregister
// @access  Private
export const unregisterDevice = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id;
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return next(new AppError('A push token is required', 400));
    }

    await prisma.deviceToken.deleteMany({ where: { token, userId } });

    res.json({ success: true, message: 'Device unregistered' });
  }
);

// @desc    Read notification preferences
// @route   GET /api/notifications/preferences
// @access  Private
export const getPreferences = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { pushEnabled: true, budgetAlertsEnabled: true },
  });

  res.json({
    success: true,
    data: {
      pushEnabled: user?.pushEnabled ?? true,
      budgetAlertsEnabled: user?.budgetAlertsEnabled ?? true,
    },
  });
});

// @desc    Update notification preferences
// @route   PATCH /api/notifications/preferences
// @access  Private
export const updatePreferences = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { pushEnabled, budgetAlertsEnabled } = req.body;

  const data: { pushEnabled?: boolean; budgetAlertsEnabled?: boolean } = {};
  if (typeof pushEnabled === 'boolean') data.pushEnabled = pushEnabled;
  if (typeof budgetAlertsEnabled === 'boolean') data.budgetAlertsEnabled = budgetAlertsEnabled;

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: { pushEnabled: true, budgetAlertsEnabled: true },
  });

  res.json({
    success: true,
    message: 'Preferences updated',
    data: user,
  });
});

// @desc    Send a test push to this user's devices
// @route   POST /api/notifications/test
// @access  Private
export const sendTestPush = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const result = await sendPushToUser(req.user!.id, {
      title: 'ThoughtExpense',
      body: 'Push notifications are working.',
      data: { screen: 'dashboard' },
    });

    if (result.reason === 'failed') {
      return next(
        new AppError('Could not reach the push service. Try again in a moment.', 503)
      );
    }

    res.json({
      success: true,
      message: result.delivered > 0 ? 'Test notification sent' : 'No registered devices',
      data: { delivered: result.delivered, reason: result.reason },
    });
  }
);
