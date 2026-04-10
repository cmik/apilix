/**
 * S3 Sync Adapter
 *
 * Uses presigned URLs generated server-side (via the Electron main process
 * IPC channel `get-presigned-url`) so that AWS credentials never reach the
 * renderer process. The presigned URL is valid for 60 seconds; it is
 * requested fresh on every push/pull.
 *
 * Required config keys:
 *   bucket   — S3 bucket name
 *   region   — AWS region (e.g. "us-east-1")
 *   keyId / accessKeyId       — AWS Access Key ID (stored encrypted)
 *   secret / secretAccessKey  — AWS Secret Access Key (stored encrypted)
 *   prefix   — optional key prefix, defaults to "apilix/"
 */

import type { WorkspaceData } from '../../types';
import type { SyncAdapter } from '../syncEngine';
import { throwSyncRequestError } from './errors';

/**
 * Wraps fetch() so that a generic "Failed to fetch" TypeError is replaced with
 * a diagnostic message that lists the most common S3 causes.
 */
async function s3Fetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: unknown) {
    const isNetworkError =
      err instanceof TypeError &&
      /failed to fetch|network request failed|load failed/i.test((err as TypeError).message);
    if (isNetworkError) {
      // Parse bucket/region out of the presigned URL for the diagnostic message.
      let hint = '';
      try {
        const parsed = new URL(url);
        // Virtual-hosted: <bucket>.s3.<region>.amazonaws.com
        // Path-style:     s3.<region>.amazonaws.com/<bucket>/…
        const match =
          parsed.hostname.match(/^(.+?)\.s3[.-]([^.]+)\.amazonaws\.com$/) ??
          parsed.hostname.match(/^s3[.-]([^.]+)\.amazonaws\.com$/);
        hint = match
          ? ` (host: ${parsed.hostname})`
          : ` (host: ${parsed.hostname})`;
      } catch { /* ignore */ }
      throw new Error(
        `S3 network error — could not reach the bucket${hint}. ` +
        `Common causes: wrong bucket name, wrong region, bucket does not exist, ` +
        `no internet connection, or a firewall/proxy blocking the request.`,
      );
    }
    throw err;
  }
}

function readVersionHeader(headers: Headers): string | null {
  const raw = headers.get('ETag') ?? headers.get('X-Version') ?? headers.get('X-Workspace-Version');
  if (!raw) return null;
  return raw.replace(/^W\//, '').replace(/^"|"$/g, '');
}

function readTimestampHeader(headers: Headers): string | null {
  return headers.get('Last-Modified') ?? headers.get('X-Last-Modified');
}

async function getPresignedUrl(
  operation: 'PUT' | 'GET' | 'HEAD',
  config: Record<string, string>,
  workspaceId: string,
): Promise<string> {
  // Ask the Electron main process to generate the presigned URL.
  // This keeps AWS credentials inside the sandboxed main process only.
  const api = (window as any).electronAPI;
  if (!api?.getPresignedUrl) {
    throw new Error('S3 presigned URL generation requires Electron (not available in browser mode)');
  }
  const accessKeyId = config.keyId ?? config.accessKeyId;
  const secretAccessKey = config.secret ?? config.secretAccessKey;

  return api.getPresignedUrl({
    operation,
    bucket: config.bucket,
    region: config.region,
    keyId: accessKeyId,
    secret: secretAccessKey,
    objectKey: `${config.prefix ?? 'apilix/'}${workspaceId}.json`,
  });
}

export const s3Adapter: SyncAdapter = {
  async push(workspaceId, data, config, options) {
    const url = await getPresignedUrl('PUT', config, workspaceId);
    // S3 presigned URLs don't support conditional writes by default. We still
    // pass expectedVersion in the body so custom backends can consume it.
    const res = await s3Fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data,
        lastModified: new Date().toISOString(),
        expectedVersion: options?.expectedVersion,
      }),
    });
    if (!res.ok) await throwSyncRequestError(res, 'S3 push');
  },

  async applyMerged(workspaceId, mergedData, config, expectedVersion) {
    const url = await getPresignedUrl('PUT', config, workspaceId);
    const res = await s3Fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: mergedData,
        lastModified: new Date().toISOString(),
        expectedVersion,
      }),
    });
    if (!res.ok) await throwSyncRequestError(res, 'S3 apply merged');
  },

  async pull(workspaceId, config) {
    const url = await getPresignedUrl('GET', config, workspaceId);
    const res = await s3Fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) await throwSyncRequestError(res, 'S3 pull');
    const body = await res.json() as { data: WorkspaceData };
    return body.data;
  },

  async pullWithMeta(workspaceId, config) {
    const url = await getPresignedUrl('GET', config, workspaceId);
    const res = await s3Fetch(url);
    if (res.status === 404) {
      return { data: null, remoteState: { timestamp: null, version: null } };
    }
    if (!res.ok) await throwSyncRequestError(res, 'S3 pull');
    const body = await res.json() as { data: WorkspaceData };
    return {
      data: body.data,
      remoteState: {
        timestamp: readTimestampHeader(res.headers),
        version: readVersionHeader(res.headers),
      },
    };
  },

  async getRemoteTimestamp(workspaceId, config) {
    try {
      const url = await getPresignedUrl('HEAD', config, workspaceId);
      const res = await s3Fetch(url, { method: 'HEAD' });
      if (!res.ok) return null;
      return readTimestampHeader(res.headers);
    } catch {
      return null;
    }
  },

  async getRemoteState(workspaceId, config) {
    try {
      const url = await getPresignedUrl('HEAD', config, workspaceId);
      const res = await s3Fetch(url, { method: 'HEAD' });
      if (!res.ok) return { timestamp: null, version: null };
      return {
        timestamp: readTimestampHeader(res.headers),
        version: readVersionHeader(res.headers),
      };
    } catch {
      return { timestamp: null, version: null };
    }
  },
};
