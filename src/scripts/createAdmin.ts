/**
 * Create or update a console Admin account (separate from app User).
 *
 *   pnpm admin:create -- --email ops@example.com --password 'secret' --name "Ops"
 *
 * Re-run with the same email to reset password / name.
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../config/prisma';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i === process.argv.length - 1) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const emailRaw = arg('--email') ?? process.env.ADMIN_EMAIL;
  const password = arg('--password') ?? process.env.ADMIN_PASSWORD;
  const name = arg('--name') ?? process.env.ADMIN_NAME ?? null;

  if (!emailRaw?.trim()) {
    console.error('Missing --email (or ADMIN_EMAIL env)');
    process.exit(1);
  }
  if (!password || password.length < 3) {
    console.error('Missing --password (min 3 chars) or ADMIN_PASSWORD env');
    process.exit(1);
  }
  if (password.length < 8) {
    console.warn('Warning: password is shorter than 8 characters — use only for local/dev.');
  }

  const email = emailRaw.trim().toLowerCase();
  const hashed = await bcrypt.hash(password, 12);

  const admin = await prisma.admin.upsert({
    where: { email },
    create: { email, password: hashed, name },
    // Password reset: bump tokenVersion so every existing console session is signed out.
    update: { password: hashed, name, tokenVersion: { increment: 1 } },
    select: { id: true, email: true, name: true, createdAt: true },
  });

  console.log('Admin ready:', admin.email, admin.id);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
