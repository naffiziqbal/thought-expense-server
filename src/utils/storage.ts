/**
 * Storage utility: DigitalOcean Spaces (production) or local disk (development)
 * - Folder structure: {projectName}/{prefix}/{uniqueId}.{ext}
 * - Stored in DB: /{projectName}/{prefix}/{uniqueId}.{ext}
 * - Full URL: {CDN_BASE_URL or API_BASE_URL}/uploads + storedPath
 */

import fs from 'fs/promises';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const BUCKET = process.env.SPACES_BUCKET || '';
const REGION = process.env.SPACES_REGION || 'nyc3';
const PROJECT_NAME = process.env.STORAGE_PROJECT_NAME || 'ThoughtExpense';
const LOCAL_UPLOADS_DIR = path.join(process.cwd(), 'uploads');

/**
 * S3 client uses virtual-hosted style: {bucket}.{endpoint}
 * Endpoint must be region-only (e.g. https://sgp1.digitaloceanspaces.com).
 * If user provides https://bucket.sgp1.digitaloceanspaces.com, strip the bucket.
 */
function getSpacesEndpoint(): string {
  const envEndpoint = process.env.SPACES_ENDPOINT;
  if (!envEndpoint) return `https://${REGION}.digitaloceanspaces.com`;

  try {
    const url = new URL(envEndpoint);
    const host = url.hostname;
    // If host is bucket.region.digitaloceanspaces.com, use region.digitaloceanspaces.com
    if (BUCKET && host.startsWith(`${BUCKET}.`)) {
      return `https://${host.slice(BUCKET.length + 1)}${url.pathname || ''}`;
    }
    return envEndpoint;
  } catch {
    return `https://${REGION}.digitaloceanspaces.com`;
  }
}

function getClient(): S3Client | null {
  const key = process.env.SPACES_ACCESS_KEY;
  const secret = process.env.SPACES_SECRET_KEY;

  if (!key || !secret || !BUCKET) {
    return null;
  }

  return new S3Client({
    endpoint: getSpacesEndpoint(),
    region: REGION,
    credentials: {
      accessKeyId: key,
      secretAccessKey: secret,
    },
    forcePathStyle: false,
  });
}

/**
 * Generate object key: /projectName/prefix/uniqueId.ext
 * Returns path suitable for DB storage
 */
function generateObjectKey(ext: string, prefix = 'avatars'): string {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `/${PROJECT_NAME}/${prefix}/${uniqueId}.${ext}`;
}

/**
 * Convert stored path to full URL for display
 * Uses CDN_BASE_URL when set, else API_BASE_URL + /uploads (for local storage)
 */
export function getFullUrl(storedPath: string | null | undefined): string | null {
  if (!storedPath || !storedPath.startsWith('/')) return null;

  const cdnBase = process.env.CDN_BASE_URL;
  const apiBase = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 7100}`;

  const base = cdnBase ? cdnBase.replace(/\/$/, '') : `${apiBase.replace(/\/$/, '')}/uploads`;
  return `${base}${storedPath}`;
}

/**
 * Upload to local disk (fallback when Spaces not configured)
 */
async function uploadToLocal(buffer: Buffer, objectKey: string): Promise<boolean> {
  try {
    const fullPath = path.join(LOCAL_UPLOADS_DIR, objectKey.slice(1));
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
    return true;
  } catch (err) {
    console.error('Local storage upload error:', err);
    return false;
  }
}

/**
 * Delete from local disk
 */
async function deleteFromLocal(storedPath: string): Promise<boolean> {
  try {
    const fullPath = path.join(LOCAL_UPLOADS_DIR, storedPath.slice(1));
    await fs.unlink(fullPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Local storage delete error:', err);
    }
    return true; // Ignore "file not found"
  }
}

/**
 * Upload file to Spaces or local disk
 * @param buffer File buffer
 * @param mimeType e.g. image/jpeg, image/png
 * @param prefix Folder prefix (e.g. avatars)
 * @returns Stored path for DB: /projectName/prefix/xxx.ext or null on failure
 */
export async function uploadToSpace(
  buffer: Buffer,
  mimeType: string,
  prefix = 'avatars'
): Promise<string | null> {
  const ext = mimeType.split('/')[1] || 'jpg';
  const objectKey = generateObjectKey(ext, prefix);

  const client = getClient();

  if (client) {
    const keyWithoutLeadingSlash = objectKey.slice(1);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: keyWithoutLeadingSlash,
          Body: buffer,
          ContentType: mimeType,
          ACL: 'public-read',
        })
      );
      return objectKey;
    } catch (err) {
      console.error('Storage upload error:', err);
      return null;
    }
  }

  // Fallback: local disk storage (development)
  const ok = await uploadToLocal(buffer, objectKey);
  return ok ? objectKey : null;
}

/**
 * Delete file from Spaces or local disk
 * @param storedPath Path from DB: /projectName/avatars/xxx.jpg
 * @returns true if deleted or not found, false on error
 */
export async function deleteFromSpace(storedPath: string | null | undefined): Promise<boolean> {
  if (!storedPath || !storedPath.startsWith('/')) return true;

  const client = getClient();

  if (client) {
    const keyWithoutLeadingSlash = storedPath.slice(1);
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: keyWithoutLeadingSlash,
        })
      );
      return true;
    } catch (err) {
      console.error('Storage delete error:', err);
      return false;
    }
  }

  return deleteFromLocal(storedPath);
}

/**
 * Check if file exists
 */
export async function existsInSpace(storedPath: string | null | undefined): Promise<boolean> {
  if (!storedPath || !storedPath.startsWith('/')) return false;

  const client = getClient();

  if (client) {
    const keyWithoutLeadingSlash = storedPath.slice(1);
    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: BUCKET,
          Key: keyWithoutLeadingSlash,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  try {
    const fullPath = path.join(LOCAL_UPLOADS_DIR, storedPath.slice(1));
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}
