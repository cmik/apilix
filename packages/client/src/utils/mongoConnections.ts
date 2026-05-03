import { API_BASE } from '../api';

export interface MongoConnectionSummary {
  id: string;
  name: string;
  database: string;
  authMode: string;
  hasUri: boolean;
}

export async function listMongoConnections(): Promise<MongoConnectionSummary[]> {
  const res = await fetch(`${API_BASE}/mongo/connections`);
  if (!res.ok) throw new Error(`Failed to list Mongo connections: HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.connections) ? data.connections : [];
}

export async function saveMongoConnection(input: {
  id: string;
  name: string;
  uri: string;
  database?: string;
  authMode?: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/mongo/connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Failed to save Mongo connection: HTTP ${res.status}`);
  }
}

export async function deleteMongoConnection(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/mongo/connections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Failed to delete Mongo connection: HTTP ${res.status}`);
  }
}

export async function testMongoConnection(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const res = await fetch(`${API_BASE}/mongo/connections/${encodeURIComponent(id)}/test`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Test request failed: HTTP ${res.status}`);
  }
  return res.json();
}
