'use strict';
/**
 * Apilix Team Server
 *
 * Self-hosted Express service for team workspace collaboration.
 * Runs independently from the main API server (default port 3003).
 *
 * Start: node server/team/index.js
 * Env:
 *   TEAM_PORT      — port to listen on (default: 3003)
 *   TEAM_DATA_DIR  — path to store data (default: <home>/.apilix-team)
 *   ADMIN_EMAIL    — bootstrap admin email
 *   ADMIN_PASSWORD — bootstrap admin password (hashed with bcrypt on first run)
 *
 * Routes:
 *   POST   /auth/login               — exchange credentials for JWT
 *   GET    /workspaces               — list workspaces for authenticated user
 *   POST   /workspaces               — create workspace (owner role)
 *   GET    /workspaces/:id           — get workspace metadata
 *   DELETE /workspaces/:id           — delete (owner only)
 *   PUT    /workspaces/:id/members   — add/update member (owner only)
 *   DELETE /workspaces/:id/members/:uid — remove member (owner only)
 *   GET    /workspaces/:id/data      — pull workspace data (≥viewer)
 *   PUT    /workspaces/:id/data      — push workspace data (≥editor)
 *   HEAD   /workspaces/:id/data      — get lastModified timestamp (≥viewer)
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const { signToken, requireAuth } = require('./auth');
const { requireRole } = require('./rbac');
const TeamStore = require('./store');

const PORT = parseInt(process.env.TEAM_PORT ?? '3003', 10);
const DATA_DIR = process.env.TEAM_DATA_DIR ?? path.join(os.homedir(), '.apilix-team');

const store = new TeamStore(DATA_DIR);
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── Auth ──────────────────────────────────────────────────────────────────────

function hashPassword(password) {
  // bcrypt is optional — fall back to SHA-512 with a salt stored next to the hash
  try {
    const bcrypt = require('bcryptjs');
    return bcrypt.hashSync(password, 12);
  } catch {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha512').update(salt + password).digest('hex');
    return `sha512:${salt}:${hash}`;
  }
}

function verifyPassword(password, stored) {
  try {
    const bcrypt = require('bcryptjs');
    if (!stored.startsWith('sha512:')) return bcrypt.compareSync(password, stored);
  } catch { /* fall through */ }
  if (stored.startsWith('sha512:')) {
    const [, salt, hash] = stored.split(':');
    const candidate = crypto.createHash('sha512').update(salt + password).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
  }
  return false;
}

/** Bootstrap admin user on first run. */
function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = store.getUserByEmail(email);
  if (existing) return; // already registered

  const id = crypto.randomBytes(8).toString('hex');
  store.saveUser({ id, name: 'Admin', email, passwordHash: hashPassword(password), role: 'owner' });
  console.log(`[team] Admin user bootstrapped: ${email}`);
}

ensureAdmin();

// POST /auth/login
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const user = store.getUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken({ sub: user.id, role: user.role }, DATA_DIR);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// All routes below require authentication
const auth = requireAuth(DATA_DIR);

// ─── Workspace routes ──────────────────────────────────────────────────────────

// GET /workspaces — list the caller's workspaces
app.get('/workspaces', auth, (req, res) => {
  const list = store.getWorkspacesForUser(req.user.sub).map(ws => ({
    id: ws.id,
    name: ws.name,
    ownerId: ws.ownerId,
    createdAt: ws.createdAt,
    role: store.getMemberRole(ws.id, req.user.sub),
    membersCount: Object.keys(ws.members ?? {}).length + 1,
  }));
  res.json({ workspaces: list });
});

// POST /workspaces — create a new workspace
app.post('/workspaces', auth, (req, res) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = crypto.randomBytes(8).toString('hex');
  const ws = { id, name, ownerId: req.user.sub, createdAt: new Date().toISOString(), members: {} };
  store.saveWorkspace(ws);
  res.status(201).json({ workspace: ws });
});

// GET /workspaces/:id
app.get('/workspaces/:id', auth, (req, res) => {
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Not found' });
  const role = store.getMemberRole(ws.id, req.user.sub);
  if (!role) return res.status(403).json({ error: 'No access' });
  res.json({ workspace: { ...ws, role } });
});

// DELETE /workspaces/:id — owner only
app.delete('/workspaces/:id', auth, (req, res) => {
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Not found' });
  if (ws.ownerId !== req.user.sub) return res.status(403).json({ error: 'Owner only' });
  store.deleteWorkspace(req.params.id);
  res.json({ ok: true });
});

// PUT /workspaces/:id/members — add or update a member (owner only)
app.put('/workspaces/:id/members', auth, (req, res) => {
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Not found' });
  if (ws.ownerId !== req.user.sub) return res.status(403).json({ error: 'Owner only' });
  const { userId, role } = req.body ?? {};
  if (!userId || !['editor', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'userId and role (editor|viewer) required' });
  }
  ws.members = ws.members ?? {};
  ws.members[userId] = role;
  store.saveWorkspace(ws);
  res.json({ ok: true });
});

// DELETE /workspaces/:id/members/:uid — remove a member (owner only)
app.delete('/workspaces/:id/members/:uid', auth, (req, res) => {
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Not found' });
  if (ws.ownerId !== req.user.sub) return res.status(403).json({ error: 'Owner only' });
  delete (ws.members ?? {})[req.params.uid];
  store.saveWorkspace(ws);
  res.json({ ok: true });
});

// ─── Workspace data routes ─────────────────────────────────────────────────────

function membershipGuard(minRole) {
  return (req, res, next) => {
    const role = store.getMemberRole(req.params.id, req.user.sub);
    if (!role) return res.status(403).json({ error: 'No access to this workspace' });
    req.memberRole = role;
    req.workspaceMeta = store.getWorkspace(req.params.id);
    next();
  };
}

// HEAD /workspaces/:id/data
app.head('/workspaces/:id/data', auth, membershipGuard('viewer'), (req, res) => {
  const meta = store.getWorkspaceDataMeta(req.params.id);
  if (!meta) return res.status(404).end();
  res.set('X-Last-Modified', meta.lastModified).end();
});

// GET /workspaces/:id/data
app.get('/workspaces/:id/data', auth, membershipGuard('viewer'), (req, res) => {
  const record = store.getWorkspaceData(req.params.id);
  if (!record) return res.status(404).json({ error: 'No data yet' });
  res.set('X-Last-Modified', record.lastModified).json({ data: record.data });
});

// PUT /workspaces/:id/data
app.put('/workspaces/:id/data', auth, membershipGuard('editor'), requireRole('editor'), (req, res) => {
  const { data } = req.body ?? {};
  if (!data) return res.status(400).json({ error: 'data is required' });
  store.saveWorkspaceData(req.params.id, data);
  res.json({ ok: true, lastModified: new Date().toISOString() });
});

// ─── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Apilix Team Server running on http://localhost:${PORT}`);
  console.log(`  Data directory: ${DATA_DIR}\n`);
});
