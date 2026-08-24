import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = process.env.EMAIL_FROM || 'ThoughtExpense <onboarding@resend.dev>';
const APP_NAME = process.env.APP_NAME || 'ThoughtExpense';

/**
 * Send forgot password email with reset link
 */
export async function sendForgotPasswordEmail(
  to: string,
  resetLink: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY is not set');
      return { success: false, error: 'Email service not configured' };
    }

    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: `Reset your ${APP_NAME} password`,
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #0d9488; margin-bottom: 16px;">Reset your password</h2>
          <p style="color: #374151; line-height: 1.6;">
            You requested a password reset for your ${APP_NAME} account.
          </p>
          <p style="color: #374151; line-height: 1.6;">
            Click the button below to set a new password. This link will expire in 1 hour.
          </p>
          <a href="${resetLink}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: #0d9488; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Reset Password
          </a>
          <p style="color: #6b7280; font-size: 14px;">
            If you didn't request this, you can safely ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            ${APP_NAME} — Track expenses with natural language
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('Resend error:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    console.error('Failed to send forgot password email:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send email',
    };
  }
}

/**
 * Send password reset OTP (6-digit code) email
 */
export async function sendPasswordResetOtpEmail(
  to: string,
  otp: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY is not set');
      return { success: false, error: 'Email service not configured' };
    }

    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: `${otp} is your ${APP_NAME} reset code`,
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #0d9488; margin-bottom: 16px;">Your password reset code</h2>
          <p style="color: #374151; line-height: 1.6;">
            Use this code to reset your ${APP_NAME} password. It expires in 10 minutes.
          </p>
          <div style="margin: 24px 0; padding: 16px 24px; background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 12px; text-align: center;">
            <span style="font-size: 34px; font-weight: 700; letter-spacing: 10px; color: #0d9488;">${otp}</span>
          </div>
          <p style="color: #6b7280; font-size: 14px;">
            If you didn't request this, you can safely ignore this email — your password will not change.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            ${APP_NAME} — Track expenses with natural language
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('Resend error:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    console.error('Failed to send OTP email:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send email',
    };
  }
}
