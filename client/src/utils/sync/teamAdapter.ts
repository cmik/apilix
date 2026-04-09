/**
 * Team Server Adapter
 *
 * Syncs workspace data with an Apilix team server (the self-hosted
 * Express service in `server/team/`). RBAC is enforced server-side.
 *
 * Required config keys:
 *   serverUrl         — base URL of the team server (e.g. "https://apilix.example.com")
 *   workspaceServerId — the workspace ID as known by the team server
 *   token             — JWT session token (stored encrypted)
 */

import type { WorkspaceData } from '../../types';
import type { SyncAdapter } from '../syncEngine';

function readVersionHeader(headers: Headers): string | null {
  const raw = headers.get('ETag') ?? headers.get('X-Version') ?? headers.get('X-Workspace-Version');
  if (!raw) return null;
  return raw.replace(/^W\//, '').replace(/^"|"$/g, '');
}

function readTimestampHeader(headers: Headers): string | null {
  return headers.get('X-Last-Modified') ?? headers.get('Last-Modified');
}

export const teamAdapter: SyncAdapter = {
  async push(_workspaceId, data, config, options) {
    const url = `${config.serverUrl}/workspaces/${config.workspaceServerId}/data`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
        ...(options?.expectedVersion ? { 'If-Match': options.expectedVersion } : {}),
      },
      body: JSON.stringify({ data, expectedVersion: options?.expectedVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Team push failed (${res.status}): ${body.error ?? res.statusText}`);
    }
  },

  async applyMerged(_workspaceId, mergedData, config, expectedVersion) {
    const url = `${config.serverUrl}/workspaces/${config.workspaceServerId}/data`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
        'If-Match': expectedVersion,
      },
      body: JSON.stringify({ data: mergedData, expectedVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Team apply merged failed (${res.status}): ${body.error ?? res.statusText}`);
    }
  },

  async pull(_workspaceId, config) {
    const url = `${config.serverUrl}/workspaces/${config.workspaceServerId}/data`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Team pull failed (${res.status}): ${body.error ?? res.statusText}`);
    }
    const body = await res.json() as { data: WorkspaceData };
    return body.data;
  },

  async pullWithMeta(_workspaceId, config) {
    const url = `${config.serverUrl}/workspaces/${config.workspaceServerId}/data`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (res.status === 404) {
      return { data: null, remoteState: { timestamp: null, version: null } };
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Team pull failed (${res.status}): ${body.error ?? res.statusText}`);
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
      const url = `${config.serverUrl}/workspaces/${config.workspaceServerId}/data`;
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${config.token}` },
      });
      if (!res.ok) return null;
      return readTimestampHeader(res.headers);
    } catch {
      return null;
    }
  },

  async getRemoteState(_workspaceId, config) {
    try {
      const url = `${config.serverUrl}/workspaces/${config.workspaceServerId}/data`;
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${config.token}` },
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
