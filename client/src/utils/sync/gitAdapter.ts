/**
 * Git Sync Adapter
 *
 * Delegates to the local API server (`server/index.js`) which runs
 * `simple-git` commands server-side. This means no git binary is required
 * in the renderer process, and credentials stay on the server.
 *
 * Required config keys:
 *   remote   — git remote URL (e.g. "https://github.com/user/api-workspace.git")
 *   branch   — branch name, defaults to "main"
 *   username — git username (for HTTPS authentication)
 *   token    — personal access token (stored encrypted)
 *
 * The server stores each workspace in a local git repository at
 * `userData/git-sync/workspaces/{workspaceId}/`, with the workspace data
 * written to `workspace.json` inside that repository directory.
 */

import type { WorkspaceData } from '../../types';
import type { SyncAdapter } from '../syncEngine';
import { getDataDir } from '../storageDriver';

function serverUrl(): string {
  const port = (window as any).electronAPI?.serverPort ?? 3001;
  return `http://localhost:${port}`;
}

export const gitAdapter: SyncAdapter = {
  async push(workspaceId, data, config) {
    const dataDir = await getDataDir();
    const res = await fetch(`${serverUrl()}/api/sync/git/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, data, config, dataDir }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Git push failed: ${body.error ?? res.statusText}`);
    }
  },

  async pull(workspaceId, config) {
    const dataDir = await getDataDir();
    const res = await fetch(`${serverUrl()}/api/sync/git/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, config, dataDir }),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Git pull failed: ${body.error ?? res.statusText}`);
    }
    const body = await res.json() as { data: WorkspaceData };
    return body.data;
  },

  async getRemoteTimestamp(workspaceId, config) {
    try {
      const dataDir = await getDataDir();
      const res = await fetch(`${serverUrl()}/api/sync/git/timestamp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, config, dataDir }),
      });
      if (!res.ok) return null;
      const body = await res.json() as { timestamp: string | null };
      return body.timestamp;
    } catch {
      return null;
    }
  },
};
