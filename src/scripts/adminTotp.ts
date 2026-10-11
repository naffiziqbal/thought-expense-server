/**
 * Turn two-factor sign-in on or off for a console Admin. Run on the API host:
 *
 *   pnpm admin:totp -- --email ops@example.com              # set up (or replace) the authenticator
 *   pnpm admin:totp -- --email ops@example.com --disable    # remove it
 *
 * Setting up prints a secret and an otpauth:// link. Add either to an
 * authenticator app (Google Authenticator, 1Password, Authy), then sign in with
 * a code. Changing it signs the admin out everywhere.
 */

import 'dotenv/config';
import prisma from '../config/prisma';
import { currentStep, generateTotpSecret, totpAt, totpUri } from '../services/totp.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i === process.argv.length - 1) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const email = (arg('--email') ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const disable = process.argv.includes('--disable');
  if (!email) {
    console.error('Missing --email');
    process.exit(1);
  }

  const admin = await prisma.admin.findUnique({ where: { email }, select: { id: true } });
  if (!admin) {
    console.error(`No admin with email ${email}`);
    process.exit(1);
  }

  if (disable) {
    await prisma.admin.update({
      where: { id: admin.id },
      data: { totpSecret: null, totpEnabledAt: null, tokenVersion: { increment: 1 } },
    });
    console.log(`Two-factor sign-in removed for ${email}. Their console sessions were signed out.`);
    return;
  }

  const secret = generateTotpSecret();
  await prisma.admin.update({
    where: { id: admin.id },
    data: { totpSecret: secret, totpEnabledAt: new Date(), tokenVersion: { increment: 1 } },
  });

  console.log(`Two-factor sign-in is on for ${email}. Their console sessions were signed out.\n`);
  console.log('Add this to an authenticator app, either as a setup key:\n');
  console.log(`  ${secret.match(/.{1,4}/g)?.join(' ')}\n`);
  console.log('or as a link (paste into a QR generator you trust, or open on the phone):\n');
  console.log(`  ${totpUri(secret, email)}\n`);
  console.log(
    `To check the app is set up right, its code should be about ${totpAt(secret, currentStep())} right now.`
  );
  console.log('Clear this terminal afterwards: the secret is a password.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
