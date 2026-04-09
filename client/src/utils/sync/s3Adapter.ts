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
 *   keyId    — AWS Access Key ID  (stored encrypted in sync-config.json)
 *   secret   — AWS Secret Access Key (stored encrypted)
 *   prefix   — optional key prefix, defaults to "apilix/"
 */

import type { WorkspaceData } from '../../types';
import type { SyncAdapter } from '../syncEngine';

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
  return api.getPresignedUrl({
    operation,
    bucket: config.bucket,
    region: config.region,
    keyId: config.keyId,
    secret: config.secret,
    objectKey: `${config.prefix ?? 'apilix/'}${workspaceId}.json`,
  });
}

export const s3Adapter: SyncAdapter = {
  async push(workspaceId, data, config) {
    const url = await getPresignedUrl('PUT', config, workspaceId);
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, lastModified: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status} ${res.statusText}`);
  },

  async pull(workspaceId, config) {
    const url = await getPresignedUrl('GET', config, workspaceId);
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status} ${res.statusText}`);
    const body = await res.json() as { data: WorkspaceData };
    return body.data;
  },

  async getRemoteTimestamp(workspaceId, config) {
    try {
      const url = await getPresignedUrl('HEAD', config, workspaceId);
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) return null;
      return res.headers.get('Last-Modified');
    } catch {
      return null;
    }
  },
};
