import fs from 'fs/promises';
import path from 'path';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Read-side of the database backups (written by scripts/backup-db.sh +
 * scripts/spaces-backup.js — same env vars, same bucket layout).
 */

const BUCKET = process.env.BACKUP_SPACES_BUCKET;
const PREFIX = (process.env.BACKUP_SPACES_PREFIX || 'thoughtexpense/db').replace(/^\/+|\/+$/g, '');
const REGION = process.env.BACKUP_SPACES_REGION || process.env.SPACES_REGION || 'sgp1';

export class BackupNotFoundError extends Error {}
export class BackupStorageUnavailableError extends Error {}

let s3: S3Client | null | undefined;

function client(): S3Client | null {
  if (s3 !== undefined) return s3;
  const accessKeyId = process.env.BACKUP_SPACES_ACCESS_KEY || process.env.SPACES_ACCESS_KEY;
  const secretAccessKey = process.env.BACKUP_SPACES_SECRET_KEY || process.env.SPACES_SECRET_KEY;
  s3 =
    BUCKET && accessKeyId && secretAccessKey
      ? new S3Client({
          endpoint:
            process.env.BACKUP_SPACES_ENDPOINT || `https://${REGION}.digitaloceanspaces.com`,
          region: REGION,
          credentials: { accessKeyId, secretAccessKey },
          forcePathStyle: false,
        })
      : null;
  return s3;
}

/** backup-db.sh touches BACKUP_DIR/last_success after a verified dump. Null if not readable here. */
export async function readLastBackupSuccess(): Promise<Date | null> {
  const dir = process.env.BACKUP_DIR || '/var/backups/thought-expense';
  try {
    return (await fs.stat(path.join(dir, 'last_success'))).mtime;
  } catch {
    return null;
  }
}

export interface BackupObject {
  key: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

export async function listBackups(limit = 10): Promise<{
  configured: boolean;
  bucket: string | null;
  total: number;
  items: BackupObject[];
}> {
  const s3c = client();
  if (!s3c) return { configured: false, bucket: null, total: 0, items: [] };

  const objects: _Object[] = [];
  let ContinuationToken: string | undefined;
  do {
    const page = await s3c.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}/`, ContinuationToken })
    );
    for (const obj of page.Contents ?? []) if (obj.Key?.endsWith('.dump')) objects.push(obj);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);

  objects.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));
  return {
    configured: true,
    bucket: BUCKET ?? null,
    total: objects.length,
    items: objects.slice(0, limit).map((o) => ({
      key: o.Key!,
      fileName: path.basename(o.Key!),
      sizeBytes: o.Size ?? 0,
      createdAt: (o.LastModified ?? new Date(0)).toISOString(),
    })),
  };
}

/** Only keys this service would list: under the backup prefix, one level deep, *.dump. */
export function isBackupKey(key: string): boolean {
  if (!key.startsWith(`${PREFIX}/`) || !key.endsWith('.dump')) return false;
  const name = key.slice(PREFIX.length + 1);
  return name.length > 5 && !name.includes('/') && !name.includes('..');
}

/** Private, expiring download URL for one dump. */
export async function createBackupDownloadLink(
  key: string,
  minutes: number
): Promise<{ url: string; expiresAt: string }> {
  if (!isBackupKey(key)) throw new BackupNotFoundError('Not a backup file');
  const s3c = client();
  if (!s3c) throw new BackupStorageUnavailableError('Backup storage is not configured');

  try {
    await s3c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) throw new BackupNotFoundError('Backup not found');
    throw err;
  }

  const expiresIn = Math.min(Math.max(1, Math.round(minutes * 60)), 7 * 24 * 3600);
  const url = await getSignedUrl(
    s3c,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${path.basename(key)}"`,
    }),
    { expiresIn }
  );
  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}
