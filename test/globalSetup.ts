import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'prisma/migrations');

function run(cmd: string, input?: string) {
  execSync(cmd, {
    cwd: root,
    stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    env: process.env,
    input,
  });
}

function isP3005(error: unknown): boolean {
  const parts: string[] = [];
  if (error && typeof error === 'object') {
    const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    if (e.stderr) parts.push(String(e.stderr));
    if (e.stdout) parts.push(String(e.stdout));
    if (e.message) parts.push(e.message);
  }
  return parts.join('\n').includes('P3005');
}

function listMigrationNames(): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function syncSchemaDrift() {
  const url = process.env.DATABASE_URL!;
  const script = execSync(
    `pnpm exec prisma migrate diff --from-url ${JSON.stringify(url)} --to-schema-datamodel prisma/schema.prisma --script`,
    { cwd: root, encoding: 'utf8', env: process.env }
  ).trim();
  if (script && !script.includes('empty migration')) {
    run('pnpm exec prisma db execute --stdin', script);
  }
}

/** Mark all repo migrations applied (local DB was often created with db push). */
function baselineMigrationHistory() {
  for (const name of listMigrationNames()) {
    try {
      run(`pnpm exec prisma migrate resolve --applied ${JSON.stringify(name)}`);
    } catch {
      // Already recorded or resolve not needed for this migration.
    }
  }
}

/**
 * Keep the test database aligned with schema.prisma.
 * - CI (empty Postgres): `migrate deploy` applies all migrations.
 * - Local dev (schema from db push, no _prisma_migrations): deploy fails with P3005;
 *   sync any drift, then baseline migration history so deploy works on the next run.
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
  } catch (error) {
    if (!isP3005(error)) {
      throw error;
    }
    syncSchemaDrift();
    baselineMigrationHistory();
    run('pnpm exec prisma migrate deploy');
  }
}
