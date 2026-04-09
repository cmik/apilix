/**
 * HTTP Sync Adapter
 *
 * Pushes/pulls workspace JSON to/from any HTTP endpoint that accepts a
 * JSON body. Useful for self-hosted backends that are not Apilix team
 * servers (e.g. a company's own sync service or a cloud function).
 *
 * Required config keys:
 *   endpoint — full URL (e.g. "https://my-api.example.com/workspaces/prod")
 *   token    — Bearer token sent in `Authorization` header (stored encrypted)
 */

import type { WorkspaceData } from '../../types';
import type { SyncAdapter } from '../syncEngine';

export const httpAdapter: SyncAdapter = {
  async push(_workspaceId, data, config) {
    const res = await fetch(config.endpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ data, lastModified: new Date().toISOString() }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP push failed (${res.status}): ${text}`);
    }
  },

  async pull(_workspaceId, config) {
    const res = await fetch(config.endpoint, {
      method: 'GET',
      headers: {
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP pull failed (${res.status}): ${text}`);
    }
    const body = await res.json() as { data: WorkspaceData };
    return body.data;
  },

  async getRemoteTimestamp(_workspaceId, config) {
    try {
      const res = await fetch(config.endpoint, {
        method: 'HEAD',
        headers: {
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
      });
      if (!res.ok) return null;
      return res.headers.get('Last-Modified') ?? res.headers.get('X-Last-Modified');
    } catch {
      return null;
    }
  },
};
