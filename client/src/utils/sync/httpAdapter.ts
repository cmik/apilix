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

function readVersionHeader(headers: Headers): string | null {
  const raw = headers.get('ETag') ?? headers.get('X-Version') ?? headers.get('X-Workspace-Version');
  if (!raw) return null;
  return raw.replace(/^W\//, '').replace(/^"|"$/g, '');
}

function readTimestampHeader(headers: Headers): string | null {
  return headers.get('Last-Modified') ?? headers.get('X-Last-Modified');
}

export const httpAdapter: SyncAdapter = {
  async push(_workspaceId, data, config, options) {
    const res = await fetch(config.endpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        ...(options?.expectedVersion ? { 'If-Match': options.expectedVersion } : {}),
      },
      body: JSON.stringify({
        data,
        lastModified: new Date().toISOString(),
        expectedVersion: options?.expectedVersion,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP push failed (${res.status}): ${text}`);
    }
  },

  async applyMerged(workspaceId, mergedData, config, expectedVersion) {
    const res = await fetch(config.endpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        'If-Match': expectedVersion,
      },
      body: JSON.stringify({
        data: mergedData,
        lastModified: new Date().toISOString(),
        expectedVersion,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP apply merged failed (${res.status}): ${text}`);
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

  async pullWithMeta(_workspaceId, config) {
    const res = await fetch(config.endpoint, {
      method: 'GET',
      headers: {
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
    });
    if (res.status === 404) {
      return { data: null, remoteState: { timestamp: null, version: null } };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP pull failed (${res.status}): ${text}`);
    }
    const body = await res.json() as { data: WorkspaceData };
    return {
      data: body.data,
      remoteState: {
        timestamp: readTimestampHeader(res.headers),
        version: readVersionHeader(res.headers),
      },
    };
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
      return readTimestampHeader(res.headers);
    } catch {
      return null;
    }
  },

  async getRemoteState(_workspaceId, config) {
    try {
      const res = await fetch(config.endpoint, {
        method: 'HEAD',
        headers: {
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
      });
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
