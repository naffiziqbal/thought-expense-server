#!/usr/bin/env node
/**
 * Spaces side of the database backup pipeline.
 *
 *   node scripts/spaces-backup.js upload <file>      upload a dump, then prune
 *   node scripts/spaces-backup.js list               list stored dumps
 *   node scripts/spaces-backup.js prune [--dry-run]  apply retention only
 *   node scripts/spaces-backup.js download <key> <dest>
 *   node scripts/spaces-backup.js link <file-or-key> [hours]   print an expiring download URL
 *
 * Retention keeps every dump from the last BACKUP_KEEP_DAYS days, plus the
 * earliest dump of each month for BACKUP_KEEP_MONTHS months, and deletes the
 * rest.
 *
 * The endpoint is derived from the region rather than reused from
 * SPACES_ENDPOINT, because that variable may carry the avatar bucket's hostname.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.BACKUP_SPACES_BUCKET;
const PREFIX = (process.env.BACKUP_SPACES_PREFIX || 'thoughtexpense/db').replace(/^\/+|\/+$/g, '');
const REGION = process.env.BACKUP_SPACES_REGION || process.env.SPACES_REGION || 'sgp1';
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 14);
const KEEP_MONTHS = Number(process.env.BACKUP_KEEP_MONTHS || 12);

const DAY_MS = 24 * 60 * 60 * 1000;

function die(message) {
  console.error(`spaces-backup: ${message}`);
  process.exit(1);
}

function client() {
  // A key scoped to the backup bucket is preferred; fall back to the shared
  // Spaces credentials so this works without extra setup.
  const accessKeyId = process.env.BACKUP_SPACES_ACCESS_KEY || process.env.SPACES_ACCESS_KEY;
  const secretAccessKey = process.env.BACKUP_SPACES_SECRET_KEY || process.env.SPACES_SECRET_KEY;

  if (!BUCKET) die('BACKUP_SPACES_BUCKET is not set');
  if (!accessKeyId || !secretAccessKey) {
    die('set BACKUP_SPACES_ACCESS_KEY and BACKUP_SPACES_SECRET_KEY (or SPACES_ACCESS_KEY / SPACES_SECRET_KEY)');
  }

  return new S3Client({
    endpoint: process.env.BACKUP_SPACES_ENDPOINT || `https://${REGION}.digitaloceanspaces.com`,
    region: REGION,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });
}

async function listAll(s3) {
  const objects = [];
  let ContinuationToken;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}/`, ContinuationToken })
    );
    for (const obj of page.Contents || []) {
      if (obj.Key.endsWith('.dump')) objects.push(obj);
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);

  return objects.sort((a, b) => b.LastModified - a.LastModified);
}

/** Keys that retention no longer needs. */
function expired(objects, now = Date.now()) {
  const dailyCutoff = now - KEEP_DAYS * DAY_MS;
  const monthCutoff = new Date(now);
  monthCutoff.setUTCMonth(monthCutoff.getUTCMonth() - KEEP_MONTHS);

  const keep = new Set();
  const monthly = new Map();

  for (const obj of objects) {
    if (obj.LastModified.getTime() >= dailyCutoff) {
      keep.add(obj.Key);
      continue;
    }
    const month = obj.LastModified.toISOString().slice(0, 7);
    const held = monthly.get(month);
    if (!held || obj.LastModified < held.LastModified) monthly.set(month, obj);
  }

  for (const obj of monthly.values()) {
    if (obj.LastModified >= monthCutoff) keep.add(obj.Key);
  }

  return objects.filter((obj) => !keep.has(obj.Key)).map((obj) => obj.Key);
}

async function prune(s3, { dryRun = false } = {}) {
  const objects = await listAll(s3);

  // Refuse to prune when there is almost nothing stored: that pattern means
  // something is wrong with listing, not that the bucket needs tidying.
  if (objects.length <= 1) {
    console.log(`prune: ${objects.length} dump(s) stored, nothing to do`);
    return;
  }

  const keys = expired(objects);
  if (keys.length === 0) {
    console.log(`prune: ${objects.length} dump(s) stored, all within retention`);
    return;
  }

  if (dryRun) {
    console.log(`prune (dry run): would delete ${keys.length} of ${objects.length}`);
    keys.forEach((key) => console.log(`  ${key}`));
    return;
  }

  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      })
    );
  }

  console.log(`prune: deleted ${keys.length} of ${objects.length} dump(s)`);
}

async function upload(s3, file) {
  if (!file) die('usage: spaces-backup.js upload <file>');
  const stat = fs.statSync(file);
  const key = `${PREFIX}/${path.basename(file)}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fs.createReadStream(file),
      ContentLength: stat.size,
      ContentType: 'application/octet-stream',
      ACL: 'private',
    })
  );

  console.log(`uploaded ${key} (${stat.size} bytes)`);
  await prune(s3);
}

async function list(s3) {
  const objects = await listAll(s3);
  if (objects.length === 0) {
    console.log(`no dumps under ${BUCKET}/${PREFIX}/`);
    return;
  }
  for (const obj of objects) {
    const mb = (obj.Size / 1024 / 1024).toFixed(2);
    console.log(`${obj.LastModified.toISOString()}  ${mb.padStart(8)} MB  ${obj.Key}`);
  }
  console.log(`\n${objects.length} dump(s) in ${BUCKET}/${PREFIX}/`);
}

async function download(s3, key, dest) {
  if (!key || !dest) die('usage: spaces-backup.js download <key> <dest>');
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await pipeline(res.Body, fs.createWriteStream(dest));
  console.log(`downloaded ${key} -> ${dest}`);
}

/**
 * Print a private download URL that stops working after `hours` (default
 * BACKUP_LINK_TTL_HOURS or 1; S3 signatures cap at 7 days). Accepts a local
 * dump path or a bare filename, resolved under the backup prefix. Anyone with
 * the URL can download the whole database: keep it short and never post it in chat.
 */
async function link(s3, fileOrKey, hoursArg) {
  if (!fileOrKey) die('usage: spaces-backup.js link <file-or-key> [hours]');
  const key = fileOrKey.startsWith(`${PREFIX}/`) ? fileOrKey : `${PREFIX}/${path.basename(fileOrKey)}`;
  const hours = Number(hoursArg || process.env.BACKUP_LINK_TTL_HOURS || 1);
  if (!Number.isFinite(hours) || hours <= 0) die(`invalid hours: ${hoursArg}`);
  const expiresIn = Math.min(Math.round(hours * 3600), 7 * 24 * 3600);

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${path.basename(key)}"`,
    }),
    { expiresIn }
  );
  process.stdout.write(`${url}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const s3 = client();

  switch (command) {
    case 'upload':
      return upload(s3, args[0]);
    case 'list':
      return list(s3);
    case 'prune':
      return prune(s3, { dryRun: args.includes('--dry-run') });
    case 'download':
      return download(s3, args[0], args[1]);
    case 'link':
      return link(s3, args[0], args[1]);
    default:
      die('usage: spaces-backup.js <upload|list|prune|download|link> [args]');
  }
}

if (require.main === module) {
  main().catch((error) => {
    const status = error?.$metadata?.httpStatusCode;
    const detail = [error?.name, error?.message, status && `HTTP ${status}`]
      .filter(Boolean)
      .join(' — ');
    die(detail || String(error));
  });
} else {
  module.exports = { expired };
}
