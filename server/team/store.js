'use strict';
/**
 * File-based JSON store for the team server.
 *
 * Layout under {dataDir}/team/:
 *   users.json          — { [userId]: { id, name, email, passwordHash, role } }
 *   workspaces.json     — { [workspaceId]: { id, name, ownerId, createdAt, members: {[userId]: role} } }
 *   data/
 *     {workspaceId}.json — WorkspaceData blob + lastModified
 */

const fs = require('fs');
const path = require('path');

class TeamStore {
  constructor(dataDir) {
    this.base = path.join(dataDir, 'team');
    this.dataDir = path.join(this.base, 'data');
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // ── Generic JSON file helpers ─────────────────────────────────────────────

  _read(file) {
    const p = path.join(this.base, file);
    if (!fs.existsSync(p)) return {};
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
  }

  _write(file, data) {
    const p = path.join(this.base, file);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  getUsers() { return this._read('users.json'); }
  getUser(id) { return this.getUsers()[id] ?? null; }
  getUserByEmail(email) {
    return Object.values(this.getUsers()).find(u => u.email === email) ?? null;
  }
  saveUser(user) {
    const users = this.getUsers();
    users[user.id] = user;
    this._write('users.json', users);
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  getWorkspaces() { return this._read('workspaces.json'); }
  getWorkspace(id) { return this.getWorkspaces()[id] ?? null; }
  saveWorkspace(ws) {
    const all = this.getWorkspaces();
    all[ws.id] = ws;
    this._write('workspaces.json', all);
  }
  deleteWorkspace(id) {
    const all = this.getWorkspaces();
    delete all[id];
    this._write('workspaces.json', all);
    const dataPath = path.join(this.dataDir, `${id}.json`);
    if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
  }

  /** Returns workspaces where userId is a member (or owner). */
  getWorkspacesForUser(userId) {
    return Object.values(this.getWorkspaces()).filter(ws =>
      ws.ownerId === userId || (ws.members && ws.members[userId]),
    );
  }

  /** Returns the role of userId in workspace, or null. */
  getMemberRole(workspaceId, userId) {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    if (ws.ownerId === userId) return 'owner';
    return ws.members?.[userId] ?? null;
  }

  // ── Workspace Data ────────────────────────────────────────────────────────

  getWorkspaceData(id) {
    const p = path.join(this.dataDir, `${id}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }
  saveWorkspaceData(id, data) {
    const p = path.join(this.dataDir, `${id}.json`);
    fs.writeFileSync(p, JSON.stringify({ data, lastModified: new Date().toISOString() }, null, 2), 'utf8');
  }
  getWorkspaceDataMeta(id) {
    const record = this.getWorkspaceData(id);
    return record ? { lastModified: record.lastModified } : null;
  }
}

module.exports = TeamStore;
