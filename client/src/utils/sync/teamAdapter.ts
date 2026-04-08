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

export const teamAdapter: SyncAdapter = {
  async push(_workspaceId, data, config) {
    const url = `${config.serverUrl}/workspaces/${config.workspaceServerId}/data`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ data }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Team push failed (${res.status}): ${body.error ?? res.statusText}`);
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

  async getRemoteTimestamp(_workspaceId, config) {
    try {
      const url = `${config.serverUrl}/workspaces/${config.workspaceServerId}/data`;
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${config.token}` },
      });
      if (!res.ok) return null;
      return (
        res.headers.get('X-Last-Modified') ??
        res.headers.get('Last-Modified')
      );
    } catch {
      return null;
    }
  },
};
