/**
 * S3 / S3-Compatible Sync Adapter
 *
 * Handles both Amazon S3 (no endpoint field) and S3-compatible services such
 * as MinIO, Backblaze B2, Cloudflare R2, etc. (endpoint field set).
 *
 * Presigned URLs are generated in the Electron main process (via the
 * `get-presigned-url` IPC channel) so credentials never reach the renderer.
 *
 * Required config keys:
 *   bucket             — Bucket name
 *   accessKeyId        — Access Key ID (stored encrypted); also accepts legacy `keyId`
 *   secretAccessKey    — Secret Access Key (stored encrypted); also accepts legacy `secret`
 *
 * Optional config keys:
 *   endpoint           — S3-compatible server URL (e.g. "http://localhost:9000");
 *                        leave blank for AWS S3
 *   region             — AWS region or SDK region (e.g. "us-east-1")
 *   prefix             — Object key prefix, defaults to "apilix/"
 */

import type { WorkspaceData } from '../../types';
import type { SyncAdapter } from '../syncEngine';
import { throwSyncRequestError } from './errors';
import {
  s3CompatFetch,
  readVersionHeader,
  readTimestampHeader,
  getPresignedUrl,
  testS3CompatConnection,
} from './s3CompatShared';

export const s3Adapter: SyncAdapter = {
  async push(workspaceId, data, config, options) {
    const url = await getPresignedUrl('PUT', config, workspaceId);
    // S3 presigned URLs don't support conditional writes by default. We still
    // pass expectedVersion in the body so custom backends can consume it.
    const res = await s3CompatFetch(url, {
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
    const res = await s3CompatFetch(url, {
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
    const res = await s3CompatFetch(url);
    if (res.status === 404) return null;
    if (!res.ok) await throwSyncRequestError(res, 'S3 pull');
    const body = await res.json() as { data: WorkspaceData };
    return body.data;
  },

  async pullWithMeta(workspaceId, config) {
    const url = await getPresignedUrl('GET', config, workspaceId);
    const res = await s3CompatFetch(url);
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
      const res = await s3CompatFetch(url, { method: 'HEAD' });
      if (!res.ok) return null;
      return readTimestampHeader(res.headers);
    } catch {
      return null;
    }
  },

  async getRemoteState(workspaceId, config) {
    try {
      const url = await getPresignedUrl('HEAD', config, workspaceId);
      const res = await s3CompatFetch(url, { method: 'HEAD' });
      if (!res.ok) return { timestamp: null, version: null };
      return {
        timestamp: readTimestampHeader(res.headers),
        version: readVersionHeader(res.headers),
      };
    } catch {
      return { timestamp: null, version: null };
    }
  },

  testConnection: testS3CompatConnection,
};
