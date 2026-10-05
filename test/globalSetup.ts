import { execSync } from 'node:child_process';
import path from 'node:path';
import dotenv from 'dotenv';

const root = path.resolve(__dirname, '..');

function run(cmd: string, input?: string) {
  execSync(cmd, {
    cwd: root,
    stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    env: process.env,
    input,
  });
}

function syncSchemaDrift() {
  const url = process.env.DATABASE_URL!;
  const script = execSync(
    `pnpm exec prisma migrate diff --from-url ${JSON.stringify(url)} --to-schema-datamodel prisma/schema.prisma --script`,
    { cwd: root, encoding: 'utf8', env: process.env }
  ).trim();
  if (script) {
    run('pnpm exec prisma db execute --stdin', script);
  }
}

/**
 * Keep the test database aligned with schema.prisma.
 * - CI (empty Postgres): `migrate deploy` applies all migrations.
 * - Local dev (often created with db push, no _prisma_migrations): deploy may fail
 *   with P3005; we then apply any missing DDL via migrate diff.
 */
export default function globalSetup() {
  dotenv.config({ path: path.join(root, '.env') });

  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example and run tests against a Postgres instance.'
    );
  }

  try {
    run('pnpm exec prisma migrate deploy');
  } catch {
    syncSchemaDrift();
  }
}
