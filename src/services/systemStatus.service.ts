import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import prisma from '../config/prisma';
import { logger } from '../config/logger';

/** server/ — same from src/services (ts-node) and dist/services (build). */
const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(SERVER_ROOT, 'prisma', 'migrations');

export async function getDatabaseHealth(): Promise<{
  ok: boolean;
  latencyMs: number | null;
  version: string | null;
  message?: string;
}> {
  const started = Date.now();
  try {
    const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    const full = rows[0]?.version ?? '';
    return {
      ok: true,
      latencyMs: Date.now() - started,
      // "PostgreSQL 16.4 on x86_64-pc-linux-musl, compiled by ..." → "PostgreSQL 16.4"
      version: full.split(' on ')[0] || null,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: null,
      version: null,
      message: err instanceof Error ? err.message.slice(0, 200) : 'error',
    };
  }
}

export interface MigrationStatus {
  /** Migration folders shipped with this build. */
  total: number;
  applied: number;
  /** In the repo but not applied to this database — a deploy skipped `migrate deploy`. */
  pending: string[];
  /** Started but never finished (needs manual attention before the next deploy). */
  failed: string[];
  latestApplied: { name: string; appliedAt: string } | null;
  /** Database has no _prisma_migrations table (created with `db push`). */
  historyMissing: boolean;
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
  let repo: string[] = [];
  try {
    repo = (await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    logger.warn({ err, dir: MIGRATIONS_DIR }, 'Could not read migrations directory');
  }

  let rows: Array<{
    migration_name: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>;
  try {
    rows = await prisma.$queryRaw`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`;
  } catch {
    return {
      total: repo.length,
      applied: 0,
      pending: repo,
      failed: [],
      latestApplied: null,
      historyMissing: true,
    };
  }

  const done = rows.filter((r) => r.finished_at && !r.rolled_back_at);
  const appliedNames = new Set(done.map((r) => r.migration_name));
  const latest = done.sort((a, b) => b.finished_at!.getTime() - a.finished_at!.getTime())[0];

  return {
    total: repo.length,
    applied: repo.filter((n) => appliedNames.has(n)).length,
    pending: repo.filter((n) => !appliedNames.has(n)),
    failed: rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name),
    latestApplied: latest
      ? { name: latest.migration_name, appliedAt: latest.finished_at!.toISOString() }
      : null,
    historyMissing: false,
  };
}

export interface DeployInfo {
  commit: string | null;
  commitMessage: string | null;
  committedAt: string | null;
  /** When this API process started (≈ last deploy or restart). */
  startedAt: string;
}

function git(args: string[]): string | null {
  try {
    return (
      execFileSync('git', args, { cwd: SERVER_ROOT, encoding: 'utf8', timeout: 3000 }).trim() ||
      null
    );
  } catch {
    return null;
  }
}

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/**
 * Read at process start, not on first request: a deploy pulls new code before it
 * builds and restarts, so a later read could report a commit that isn't running yet.
 */
const DEPLOY_INFO: DeployInfo = (() => {
  const log = git(['log', '-1', '--format=%h%x00%cI%x00%s']);
  const [commit, committedAt, commitMessage] = log ? log.split('\0') : [];
  return {
    commit: commit || process.env.GIT_SHA || null,
    committedAt: committedAt || null,
    commitMessage: commitMessage?.slice(0, 120) || null,
    startedAt: PROCESS_STARTED_AT,
  };
})();

export function getDeployInfo(): DeployInfo {
  return DEPLOY_INFO;
}
