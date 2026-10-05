import { Resend } from 'resend';
import { logger } from '../config/logger';
import { isEffectiveManualLifetime } from '../utils/subscription.util';

// Lazy: the Resend constructor throws on an empty key, which would crash the
// server at boot in environments where email is not configured.
let resendClient: Resend | null = null;
function getResend(): Resend {
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const FROM_EMAIL = process.env.EMAIL_FROM || 'ThoughtExpense <onboarding@resend.dev>';
const APP_NAME = process.env.APP_NAME || 'ThoughtExpense';
const APP_URL = (process.env.FRONTEND_URL || 'https://thoughtexpense.nafiziqbal.com').replace(
  /\/$/,
  ''
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.length === 3 ? currency : 'USD',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}

function emailShell(body: string, preheader?: string): string {
  const hiddenPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>`
    : '';
  return `
    ${hiddenPreheader}
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <div style="padding: 8px 0 24px; border-bottom: 1px solid #e5e7eb;">
        <span style="font-size: 18px; font-weight: 700; color: #0d9488;">${APP_NAME}</span>
      </div>
      ${body}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />
      <p style="color: #9ca3af; font-size: 12px; line-height: 1.5; margin: 0;">
        You’re receiving this because you have a ${APP_NAME} account.
        <a href="${APP_URL}/dashboard" style="color: #0d9488;">Open dashboard</a>
      </p>
    </div>`;
}

function primaryButton(href: string, label: string): string {
  return `<a href="${href}" style="display: inline-block; margin: 20px 0 8px; padding: 12px 22px; background: #0d9488; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">${label}</a>`;
}

/**
 * Send forgot password email with reset link
 */
export async function sendForgotPasswordEmail(
  to: string,
  resetLink: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.RESEND_API_KEY) {
      logger.error('RESEND_API_KEY is not set');
      return { success: false, error: 'Email service not configured' };
    }

    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: `Reset your ${APP_NAME} password`,
      html: emailShell(
        `
          <h1 style="font-size: 22px; margin: 24px 0 12px; color: #111827;">Reset your password</h1>
          <p style="color: #374151; line-height: 1.65; margin: 0 0 12px;">
            We received a request to reset the password for your ${APP_NAME} account.
          </p>
          <p style="color: #374151; line-height: 1.65; margin: 0 0 8px;">
            Use the button below to choose a new password. The link expires in <strong>1 hour</strong>.
          </p>
          ${primaryButton(resetLink, 'Reset password')}
          <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin-top: 16px;">
            Button not working? Copy and paste this link into your browser:<br />
            <span style="word-break: break-all; color: #0d9488;">${escapeHtml(resetLink)}</span>
          </p>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin-top: 20px;">
            If you didn’t ask for this, ignore this email — your password stays the same.
          </p>
        `,
        'Reset your ThoughtExpense password — link expires in 1 hour.'
      ),
    });

    if (error) {
      logger.error({ err: error }, 'Resend error');
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    logger.error({ err }, 'Failed to send forgot password email');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send email',
    };
  }
}

interface BriefingEmailPayload {
  name: string | null;
  briefing: {
    title: string;
    summary: string;
    highlights: string[];
    recommendations: string[];
  };
  weekTotal: number;
  previousWeekTotal: number;
  currency: string;
  isPremium: boolean;
}

/**
 * Send the Weekly Financial Briefing email
 */
export async function sendWeeklyBriefingEmail(
  to: string,
  payload: BriefingEmailPayload
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.RESEND_API_KEY) {
      logger.error('RESEND_API_KEY is not set');
      return { success: false, error: 'Email service not configured' };
    }

    const { briefing, weekTotal, previousWeekTotal, currency, name, isPremium } = payload;
    const title = escapeHtml(briefing.title);
    const summary = escapeHtml(briefing.summary);
    const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hi there,';
    const thisWeek = formatMoney(weekTotal, currency);
    const lastWeek = formatMoney(previousWeekTotal, currency);
    const diffAmount = weekTotal - previousWeekTotal;
    const diffFormatted = formatMoney(Math.abs(diffAmount), currency);

    let comparisonBlock: string;
    if (previousWeekTotal <= 0 && weekTotal <= 0) {
      comparisonBlock = `<p style="margin: 0; color: #6b7280; font-size: 14px;">No spending logged this week yet.</p>`;
    } else if (previousWeekTotal <= 0) {
      comparisonBlock = `
        <p style="margin: 0; font-size: 14px; color: #374151;">First week with activity in this comparison window.</p>`;
    } else {
      const pct = Math.round(((weekTotal - previousWeekTotal) / previousWeekTotal) * 100);
      const up = diffAmount >= 0;
      const arrow = up ? '▲' : '▼';
      const color = up ? '#dc2626' : '#16a34a';
      comparisonBlock = `
        <table style="width: 100%; margin-top: 12px; font-size: 14px; color: #374151;" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding: 6px 0;">Last week</td>
            <td style="padding: 6px 0; text-align: right; font-weight: 600;">${lastWeek}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0;">This week</td>
            <td style="padding: 6px 0; text-align: right; font-weight: 600;">${thisWeek}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0 0; border-top: 1px solid #e5e7eb;">Change</td>
            <td style="padding: 8px 0 0; border-top: 1px solid #e5e7eb; text-align: right; font-weight: 600; color: ${color};">
              ${arrow} ${diffFormatted} (${pct >= 0 ? '+' : ''}${pct}%)
            </td>
          </tr>
        </table>`;
    }

    const listItems = (items: string[]) =>
      items
        .map(
          (i) =>
            `<li style="color: #374151; line-height: 1.65; margin-bottom: 10px;">${escapeHtml(i)}</li>`
        )
        .join('');

    const upgradeBlock = isPremium
      ? ''
      : `
        <div style="margin: 28px 0 0; padding: 16px 18px; background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 12px;">
          <p style="color: #115e59; margin: 0 0 8px; font-weight: 600; font-size: 14px;">Go deeper with Premium</p>
          <p style="color: #0f766e; margin: 0; font-size: 14px; line-height: 1.55;">
            12 months of history, exports, receipt OCR on web, and unlimited AI assistant — so briefings like this stay sharp.
          </p>
        </div>`;

    const insightsUrl = `${APP_URL}/dashboard/insights`;

    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: `${briefing.title} — ${APP_NAME} weekly briefing`,
      html: emailShell(
        `
          <p style="color: #6b7280; font-size: 14px; margin: 20px 0 4px;">${greeting}</p>
          <h1 style="font-size: 22px; margin: 0 0 16px; color: #111827; line-height: 1.35;">${title}</h1>
          <div style="margin: 0 0 24px; padding: 20px 22px; background: #f9fafb; border-radius: 12px; border: 1px solid #e5e7eb;">
            <div style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin-bottom: 6px;">This week</div>
            <div style="font-size: 32px; font-weight: 700; color: #111827; line-height: 1.2;">${thisWeek}</div>
            ${comparisonBlock}
          </div>
          <p style="color: #374151; line-height: 1.65; margin: 0 0 20px; font-size: 15px;">${summary}</p>
          ${
            briefing.highlights.length
              ? `
          <h2 style="color: #111827; font-size: 16px; margin: 0 0 10px;">What stood out</h2>
          <ul style="padding-left: 20px; margin: 0 0 24px;">${listItems(briefing.highlights)}</ul>`
              : ''
          }
          ${
            briefing.recommendations.length
              ? `
          <h2 style="color: #111827; font-size: 16px; margin: 0 0 10px;">Try this next week</h2>
          <ul style="padding-left: 20px; margin: 0 0 8px;">${listItems(briefing.recommendations)}</ul>`
              : ''
          }
          ${primaryButton(insightsUrl, 'View full briefing in app')}
          ${upgradeBlock}
        `,
        `${briefing.summary.slice(0, 120)}…`
      ),
    });

    if (error) {
      logger.error({ err: error }, 'Resend error');
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    logger.error({ err }, 'Failed to send weekly briefing email');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send email',
    };
  }
}

/**
 * Send password reset OTP (6-digit code) email
 */
function formatPremiumUntil(until: Date | null): { label: string; detail: string } {
  if (isEffectiveManualLifetime(until)) {
    return {
      label: 'Lifetime access',
      detail:
        'Your complimentary Premium access is granted with no practical end date (stored as long-term access in our system).',
    };
  }
  if (!until) {
    return {
      label: 'No fixed end date',
      detail: 'Your complimentary Premium access stays active until we let you know otherwise.',
    };
  }
  const label = until.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return {
    label,
    detail: `Premium access is active through <strong>${escapeHtml(label)}</strong> (UTC calendar date).`,
  };
}

export interface ManualPremiumEmailPayload {
  name: string | null;
  premiumUntil: Date | null;
  /** true = first grant; false = expiry date updated */
  isNewGrant: boolean;
}

/**
 * Notify a user that an admin granted or extended complimentary Premium.
 */
export async function sendManualPremiumGrantedEmail(
  to: string,
  payload: ManualPremiumEmailPayload
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.RESEND_API_KEY) {
      logger.error('RESEND_API_KEY is not set');
      return { success: false, error: 'Email service not configured' };
    }

    const greeting = payload.name ? `Hi ${escapeHtml(payload.name)},` : 'Hi there,';
    const { label, detail } = formatPremiumUntil(payload.premiumUntil);
    const headline = payload.isNewGrant ? 'You’ve got Premium' : 'Your Premium access was updated';
    const intro = payload.isNewGrant
      ? `We’ve activated <strong>Premium</strong> on your ${APP_NAME} account — on us.`
      : `Your complimentary <strong>Premium</strong> on ${APP_NAME} has a new end date.`;

    const premiumUrl = `${APP_URL}/dashboard/premium`;

    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: payload.isNewGrant
        ? `Premium is active on your ${APP_NAME} account`
        : `Your ${APP_NAME} Premium access was updated`,
      html: emailShell(
        `
          <p style="color: #6b7280; font-size: 14px; margin: 20px 0 4px;">${greeting}</p>
          <h1 style="font-size: 22px; margin: 0 0 16px; color: #111827; line-height: 1.35;">${headline}</h1>
          <p style="color: #374151; line-height: 1.65; margin: 0 0 16px; font-size: 15px;">${intro}</p>
          <div style="margin: 0 0 24px; padding: 20px 22px; background: #f0fdfa; border-radius: 12px; border: 1px solid #99f6e4;">
            <div style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #0f766e; margin-bottom: 8px;">Access until</div>
            <div style="font-size: 22px; font-weight: 700; color: #115e59; line-height: 1.3;">${escapeHtml(label)}</div>
            <p style="color: #0f766e; margin: 12px 0 0; font-size: 14px; line-height: 1.55;">${detail}</p>
          </div>
          <p style="color: #374151; line-height: 1.65; margin: 0 0 8px; font-size: 15px;">
            Premium includes 12 months of history, exports, deeper insights, and unlimited AI assistant — open the app and explore.
          </p>
          ${primaryButton(premiumUrl, 'Open Premium in app')}
          <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin-top: 20px;">
            Questions? Reply to this email or contact support — we’re happy to help.
          </p>
        `,
        payload.isNewGrant
          ? `Premium is active on your ${APP_NAME} account. Access until: ${label}.`
          : `Your Premium access was updated. New end date: ${label}.`
      ),
    });

    if (error) {
      logger.error({ err: error }, 'Resend error (manual premium email)');
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    logger.error({ err }, 'Failed to send manual premium email');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send email',
    };
  }
}

export async function sendPasswordResetOtpEmail(
  to: string,
  otp: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.RESEND_API_KEY) {
      logger.error('RESEND_API_KEY is not set');
      return { success: false, error: 'Email service not configured' };
    }

    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: `${otp} is your ${APP_NAME} reset code`,
      html: emailShell(
        `
          <h1 style="font-size: 22px; margin: 24px 0 12px; color: #111827;">Your reset code</h1>
          <p style="color: #374151; line-height: 1.65; margin: 0 0 16px;">
            Enter this code in the ${APP_NAME} app to set a new password. It expires in <strong>10 minutes</strong>.
          </p>
          <div style="margin: 20px 0; padding: 20px; background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 12px; text-align: center;">
            <span style="font-size: 36px; font-weight: 700; letter-spacing: 12px; color: #0d9488; font-variant-numeric: tabular-nums;">${otp}</span>
          </div>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin: 0;">
            Didn’t request a reset? Ignore this email — your password won’t change.
          </p>
        `,
        `Your ${APP_NAME} password reset code: ${otp}`
      ),
    });

    if (error) {
      logger.error({ err: error }, 'Resend error');
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    logger.error({ err }, 'Failed to send OTP email');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send email',
    };
  }
}
