import { AppError } from '../middleware/error.middleware';

export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED';

/** Sent to accounts flagged for a mandatory reset; clients route to forgot-password on the code. */
export function passwordResetRequiredError(statusCode: 401 | 403): AppError {
  return new AppError(
    'For your security, you need to reset your password now. We will email you a 6-digit code.',
    statusCode,
    PASSWORD_RESET_REQUIRED
  );
}
