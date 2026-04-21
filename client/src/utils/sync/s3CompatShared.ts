/**
 * Shared utilities for S3 and S3-compatible (MinIO, etc.) sync adapters.
 *
 * Extracted so that s3Adapter.ts and minioAdapter.ts share a single
 * implementation of header parsing, fetch error handling, presigned URL
 * generation, and connection testing.
 */

import { syncSignal } from './syncTimeout';

export function readVersionHeader(headers: Headers): string | null {
  const raw = headers.get('ETag') ?? headers.get('X-Version') ?? headers.get('X-Workspace-Version');
  if (!raw) return null;
  return raw.replace(/^W\//, '').replace(/^"|"$/g, '');
}

export function readTimestampHeader(headers: Headers): string | null {
  return headers.get('Last-Modified') ?? headers.get('X-Last-Modified');
}

/**
 * Wraps fetch() so that a generic "Failed to fetch" TypeError is replaced with
 * a provider-labelled diagnostic message.
 */
export async function s3CompatFetch(
  url: string,
  init?: RequestInit,
  providerLabel = 'S3',
): Promise<Response> {
  try {
    const callerSignal = init?.signal;
    const timeoutSignal = syncSignal();
    const signal = callerSignal
      ? AbortSignal.any([timeoutSignal, callerSignal])
      : timeoutSignal;
    const { signal: _omit, ...restInit } = init ?? {};
    return await fetch(url, { signal, ...restInit });
  } catch (err: unknown) {
    if (
      err instanceof DOMException &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      throw new Error(
        `${providerLabel} sync request timed out — server did not respond in time`,
      );
    }
    const isNetworkError =
      err instanceof TypeError &&
      /failed to fetch|network request failed|load failed/i.test((err as TypeError).message);
    if (isNetworkError) {
      let hint = '';
      try {
        const parsed = new URL(url);
        const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        const isAws = parsed.hostname.includes('amazonaws.com');
        hint = isAws ? ` (host: ${parsed.hostname})` : ` (host: ${parsed.hostname}:${port})`;
      } catch { /* ignore */ }
      throw new Error(
        `${providerLabel} network error — could not reach the server${hint}. ` +
        `Common causes: wrong endpoint URL, server not running, wrong bucket name, ` +
        `or a firewall/proxy blocking the request.`,
      );
    }
    throw err;
  }
}

/**
 * Generates a presigned URL via the Electron IPC channel `get-presigned-url`.
 *
 * When `config.endpoint` is set the payload includes `endpoint` so the main
 * process configures `forcePathStyle: true` (required by MinIO and most
 * S3-compatible services). When it is absent the standard AWS SDK path is used.
 *
 * Supports legacy key-name aliases: `keyId` / `accessKeyId` and
 * `secret` / `secretAccessKey`.
 */
export async function getPresignedUrl(
  operation: 'PUT' | 'GET' | 'HEAD',
  config: Record<string, string>,
  workspaceId: string,
): Promise<string> {
  const api = (window as any).electronAPI;
  if (!api?.getPresignedUrl) {
    throw new Error('S3 presigned URL generation requires Electron (not available in browser mode)');
  }

  const endpoint = config.endpoint?.trim();

  // Validate endpoint when provided (S3-compatible services like MinIO).
  if (endpoint) {
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch (err) {
      throw new Error(
        'S3-compatible endpoint must be a valid URL (for example, http://localhost:9000)',
        { cause: err },
      );
    }
    if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
      throw new Error('S3-compatible endpoint must use http:// or https://');
    }
  }

  // Support legacy key-name aliases used by older stored configs.
  const keyId = config.keyId ?? config.accessKeyId;
  const secret = config.secret ?? config.secretAccessKey;

  return api.getPresignedUrl({
    operation,
    bucket: config.bucket,
    region: config.region,
    keyId,
    secret,
    objectKey: `${config.prefix ?? 'apilix/'}${config.remoteWorkspaceId ?? workspaceId}.json`,
    ...(endpoint ? { endpoint } : {}),
  });
}

/**
 * Tests S3 / S3-compatible connectivity by issuing a HEAD presigned URL
 * request. Returns `{ ok, message }` — never throws.
 */
export async function testS3CompatConnection(
  workspaceId: string,
  config: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  try {
    const url = await getPresignedUrl('HEAD', config, workspaceId);
    const label = config.endpoint?.trim() ? 'MinIO' : 'S3';
    const res = await s3CompatFetch(url, { method: 'HEAD' }, label);
    if (res.ok || res.status === 404) {
      const detail = res.status === 404
        ? 'bucket reachable (object not yet created)'
        : 'bucket reachable';
      return { ok: true, message: `Connected — ${detail}` };
    }
    if (res.status === 403) {
      return { ok: false, message: 'Access denied — check Access Key and Secret Key' };
    }
    return { ok: false, message: `Server responded ${res.status} ${res.statusText}` };
  } catch (err: unknown) {
    return { ok: false, message: (err as Error).message };
  }
}
