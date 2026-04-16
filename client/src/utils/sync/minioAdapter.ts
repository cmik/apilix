/**
 * MinIO Sync Adapter
 *
 * MinIO is S3-compatible. Presigned URLs are generated in the Electron main
 * process (via the `get-presigned-url` IPC channel, shared with the S3
 * adapter) so credentials never reach the renderer.
 *
 * The `endpoint` field points at the MinIO server (e.g. "http://localhost:9000").
 * The AWS SDK is configured with `forcePathStyle: true` on the main-process
 * side so bucket names appear as path segments rather than subdomains —
 * required by MinIO's default configuration.
 *
 * Required config keys:
 *   endpoint            — MinIO server URL (e.g. "http://192.168.1.10:9000")
 *   bucket              — Bucket name
 *   accessKeyId         — MinIO access key (stored encrypted)
 *   secretAccessKey     — MinIO secret key (stored encrypted)
 *
 * Optional config keys:
 *   region              — Passed to the SDK (MinIO ignores it; defaults to "us-east-1")
 *   prefix              — Object key prefix, defaults to "apilix/"
 */

import type { WorkspaceData } from '../../types';
import type { SyncAdapter } from '../syncEngine';
import { throwSyncRequestError } from './errors';

async function minioFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: unknown) {
    const isNetworkError =
      err instanceof TypeError &&
      /failed to fetch|network request failed|load failed/i.test((err as TypeError).message);
    if (isNetworkError) {
      let hint = '';
      try {
        const parsed = new URL(url);
        hint = ` (host: ${parsed.hostname}:${parsed.port || parsed.protocol === 'https:' ? 443 : 80})`;
      } catch { /* ignore */ }
      throw new Error(
        `MinIO network error — could not reach the server${hint}. ` +
        `Common causes: wrong endpoint URL, server not running, wrong bucket name, ` +
        `or a firewall/proxy blocking the request.`,
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
  const api = (window as any).electronAPI;
  if (!api?.getPresignedUrl) {
    throw new Error('MinIO presigned URL generation requires Electron (not available in browser mode)');
  }
  return api.getPresignedUrl({
    operation,
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region || 'us-east-1',
    keyId: config.accessKeyId,
    secret: config.secretAccessKey,
    objectKey: `${config.prefix ?? 'apilix/'}${workspaceId}.json`,
  });
}

export const minioAdapter: SyncAdapter = {
  async push(workspaceId, data, config, options) {
    const url = await getPresignedUrl('PUT', config, workspaceId);
    const res = await minioFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data,
        lastModified: new Date().toISOString(),
        expectedVersion: options?.expectedVersion,
      }),
    });
    if (!res.ok) await throwSyncRequestError(res, 'MinIO push');
  },

  async applyMerged(workspaceId, mergedData, config, expectedVersion) {
    const url = await getPresignedUrl('PUT', config, workspaceId);
    const res = await minioFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: mergedData,
        lastModified: new Date().toISOString(),
        expectedVersion,
      }),
    });
    if (!res.ok) await throwSyncRequestError(res, 'MinIO apply merged');
  },

  async pull(workspaceId, config) {
    const url = await getPresignedUrl('GET', config, workspaceId);
    const res = await minioFetch(url);
    if (res.status === 404) return null;
    if (!res.ok) await throwSyncRequestError(res, 'MinIO pull');
    const body = await res.json() as { data: WorkspaceData };
    return body.data;
  },

  async pullWithMeta(workspaceId, config) {
    const url = await getPresignedUrl('GET', config, workspaceId);
    const res = await minioFetch(url);
    if (res.status === 404) {
      return { data: null, remoteState: { timestamp: null, version: null } };
    }
    if (!res.ok) await throwSyncRequestError(res, 'MinIO pull');
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
      const res = await minioFetch(url, { method: 'HEAD' });
      if (!res.ok) return null;
      return readTimestampHeader(res.headers);
    } catch {
      return null;
    }
  },

  async getRemoteState(workspaceId, config) {
    try {
      const url = await getPresignedUrl('HEAD', config, workspaceId);
      const res = await minioFetch(url, { method: 'HEAD' });
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
