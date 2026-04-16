# Apilix — Workspace Management & Collaboration

This document covers everything about workspaces: what they are, how they are stored, how to sync them to a remote, and how to collaborate with a team.

---

## Table of Contents

1. [What is a workspace?](#1-what-is-a-workspace)
2. [Local storage layout](#2-local-storage-layout)
3. [Managing workspaces](#3-managing-workspaces)
4. [Automatic history (snapshots)](#4-automatic-history-snapshots)
5. [Sync overview](#5-sync-overview)
6. [Sync provider: Git Repository](#6-sync-provider-git-repository)
7. [Sync provider: Amazon S3 / S3-Compatible](#7-sync-provider-amazon-s3--s3-compatible)
8. [Sync provider: HTTP Endpoint](#8-sync-provider-http-endpoint)
9. [Sync provider: Team Server](#9-sync-provider-team-server)
10. [Team server setup & management](#10-team-server-setup--management)
11. [Conflict resolution](#11-conflict-resolution)
12. [Choosing the right collaboration solution](#12-choosing-the-right-collaboration-solution)

---

## 1. What is a workspace?

A **workspace** is an isolated container that holds:

- Collections and requests
- Environments and environment variables
- Global variables
- Collection-scoped variables
- Cookie jar
- Mock server collections, routes, and port setting

Each workspace is completely independent — switching workspaces replaces everything visible in the UI. You can create as many workspaces as you want (e.g. one per project, one per client, one per environment tier).

### Workspace metadata

Each workspace entry in the manifest includes:

| Field | Description |
|---|---|
| `id` | Auto-generated UUID — stable identifier used for file names and sync |
| `name` | Display name |
| `color` | Accent colour (hex) shown in the switcher |
| `createdAt` | ISO timestamp of creation |
| `type` | `local` (default) or `team` (connected to a team server) |
| `role` | For team workspaces: `owner`, `editor`, or `viewer` |
| `teamServerUrl` | For team workspaces: the team server base URL |

---

## 2. Local storage layout

### Electron (desktop)

Data lives inside the system app-data directory:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Apilix/` |
| Windows | `%APPDATA%\Apilix\` |
| Linux | `~/.config/Apilix/` |

File layout:

```
{userData}/
  workspaces.json              ← manifest: list of workspaces + activeWorkspaceId
  settings.json                ← app-level settings (theme, etc.)
  sync-config.json             ← per-workspace sync credentials (encrypted)
  sync-activity.json           ← per-workspace sync activity log (newest first, max 100)
  workspaces/
    {workspaceId}.json         ← workspace data (collections, envs, …)
    {workspaceId}/
      history.json             ← snapshot index (newest first, max 50 entries)
      snapshots/
        {snapshotId}.json      ← point-in-time workspace data blob
```

### Browser / web mode

When running without Electron, all data is stored in `localStorage` with the following keys:

| Key | Content |
|---|---|
| `apilix_workspaces` | Workspace manifest |
| `apilix_workspace_{id}` | Workspace data per ID |
| `apilix_settings` | App settings |
| `apilix_sync_config` | Sync credentials |
| `apilix_sync_activity` | Per-workspace sync activity log |

> **Note:** localStorage is limited to ~5 MB and is cleared when the browser cache is cleared. Use desktop mode for reliable persistence.

### Credential storage

Sensitive sync credentials (tokens, secret keys) are encrypted using Electron's `safeStorage` API before being written to `sync-config.json`. In browser mode they are stored in plaintext in localStorage — use browser mode for development only.

---

## 3. Managing workspaces

Open **Manage Workspaces** by clicking the gear icon next to the workspace name in the sidebar.

### Workspaces tab

| Action | How |
|---|---|
| Switch | Click the workspace name in the list |
| Create | Click **+ New workspace** (creates an empty workspace and switches to it) |
| Rename | Click ✏ next to a workspace |
| Change colour | Click any colour dot on the left |
| Duplicate | Click ⧉ — copies all collections, environments, and variables into a new workspace |
| Delete | Click 🗑 — requires at least one other workspace to exist |

Clicking **Open data folder ↗** opens the Electron userData directory in the system file manager.

### Creating a new workspace

A new workspace starts completely empty (no collections, no environments). You can then:

- Import a Postman collection via **Import**
- Manually create collections
- Pull data from a remote sync provider

### Duplicating a workspace

Duplication performs a deep clone — all IDs are preserved and the new workspace is immediately activated. It is useful for creating a staging copy of a production workspace.

---

## 4. Automatic history (snapshots)

Apilix automatically creates a snapshot every time the active workspace is saved to disk (debounced, roughly 1–2 seconds after the last change).

### History tab

Open **Manage Workspaces → History** to see the full snapshot timeline, newest first.

Each entry shows:
- Auto-generated summary (e.g. `3 collection(s), auto-save`)
- Timestamp (local time)
- Number of collections at the time of the snapshot

Click an entry to expand it, then click **Restore this snapshot** to roll back the workspace to that exact state. The current state is overwritten — if you need to preserve it, duplicate the workspace first.

### Snapshot limits

Up to **50 snapshots** are kept per workspace. When the limit is reached the oldest snapshot is automatically deleted.

### Snapshot storage location

```
{userData}/workspaces/{workspaceId}/
  history.json            ← index with summary metadata
  snapshots/
    {snapshotId}.json     ← full workspace data blob
```

---

## 5. Sync overview

The **Sync tab** in Manage Workspaces lets you push and pull a workspace to/from a remote provider. All four providers share the same three operations:

| Operation | Button | Description |
|---|---|---|
| **Push ↑** | Push ↑ | Serialises the current workspace and uploads it to the remote. Config is saved first. |
| **Pull ↓** | Pull ↓ | Downloads remote data and replaces the local workspace. Config is saved first. |
| **Save config** | Save config | Persists the connection fields to disk without pushing or pulling. |
| **Import once ↓** | Import once (don't save config) ↓ | Pulls once without persisting the config — useful for a one-time clone. |

### Conflict detection

Before every pull Apilix compares the remote timestamp against the local sync metadata (`lastSyncedAt`). If the remote is newer, Apilix opens a **three-way merge review**:

- **Base**: last known common snapshot (`lastMergeBaseSnapshotId`) when available
- **Local**: current workspace state
- **Remote**: latest provider state

The merge modal lists request-level and code-level conflicts and lets you:

- take local or remote per conflict,
- manually edit resolved content,
- apply the merged result with optimistic version checks where supported.

If merge data cannot be loaded, the UI falls back to the legacy binary choices:

- **Use Remote** — overwrite local with remote data
- **Keep Local** — keep local and cancel pull

### Provider capability notes

All providers support conflict detection and merge UI, but write guarantees differ:

- **Git / HTTP / Team**: support optimistic versioned writes (conditional apply) where stale remote versions return `409 STALE_VERSION`.
- **S3**: presigned URL flow does not guarantee conditional writes in the default setup; optimistic protection depends on a custom backend contract.

When an optimistic merge apply loses the race (`STALE_VERSION`), Apilix automatically rebuilds a fresh merge package against the newest remote and reopens merge review.

### Sync activity telemetry

The Sync tab now shows **Recent sync activity** (local telemetry), including:

- push/pull/import outcomes,
- conflict detection,
- merge review open/apply,
- stale-apply rebase attempts,
- save-config events.

Entries are persisted per workspace in `sync-activity.json` (desktop) or `apilix_sync_activity` (browser mode).

---

## 6. Sync provider: Git Repository

Stores the workspace as a `workspace.json` file inside a local git clone that is pushed to / pulled from a remote repository.

### How it works

1. On first push Apilix initialises a bare git repo at `{userData}/git-sync/workspaces/{workspaceId}/`.
2. The workspace JSON is written to `workspace.json` and committed.
3. The commit is pushed to the configured remote using `simple-git`.
4. On pull the remote is fetched and `workspace.json` is read back.

### Prerequisites

- **Git must be installed** on the machine running the Apilix server (`git --version`).
- A remote repository on GitHub, GitLab, Gitea, or any other git host.
- The remote should be **empty** (no initial commit) for a clean first push. If it already has commits, use **Import once ↓** before pushing.

### Field reference

| Field | Required | Notes |
|---|:---:|---|
| Remote URL | ✅ | HTTPS or SSH URL, e.g. `https://github.com/user/repo.git` |
| Branch | — | Defaults to `main` if blank |
| Username | — | HTTPS auth only; not needed for SSH |
| Token / Password | — | Personal Access Token; used together with Username |
| Author Name | ⚠ | Required for commits unless `git config --global user.name` is set |
| Author Email | ⚠ | Required for commits unless `git config --global user.email` is set |

### Generating a Personal Access Token

**GitHub:**
1. Settings → Developer settings → Personal access tokens → Generate new token (classic)
2. Select the `repo` scope
3. Copy the token and enter it in the Token field

**GitLab:**
1. User Settings → Access Tokens
2. Select `read_repository` + `write_repository` scopes
3. Copy the token

### Step-by-step setup

1. Create an **empty** repo on your git host (no README, no .gitignore).
2. Generate a PAT (see above).
3. Open **Manage Workspaces → Sync → Git Repository**.
4. Fill in Remote URL, Branch, Username, Token, Author Name, Author Email.
5. Click **Save config** to persist the credentials.
6. Click **Push ↑** — the first push initialises the local repo and uploads `workspace.json`.
7. On another machine, fill in the same fields and click **Pull ↓**.

### Ongoing usage

| Scenario | Action |
|---|---|
| You made changes locally | Push ↑ |
| A teammate pushed changes | Pull ↓ |
| First time on a new machine | Configure fields → Pull ↓ |
| One-off clone without saving credentials | Import once ↓ |
| Remote already has existing commits | Import once ↓ first, then Push ↑ |

### Authentication over HTTPS

When both Username and Token are provided, Apilix embeds the credentials in the remote URL:

```
https://{username}:{token}@github.com/user/repo.git
```

This is done server-side only and the credential-embedded URL is never stored.

### SSH remotes

For SSH remotes (`git@github.com:user/repo.git`), leave Username and Token blank. The git process on the server machine will use the system's SSH agent or `~/.ssh/config`.

---

## 7. Sync provider: Amazon S3 / S3-Compatible

Stores the workspace as a JSON object in an S3-compatible bucket. Presigned URLs are generated inside the Electron main process so that AWS credentials never reach the renderer. Both Amazon S3 and self-hosted S3-compatible services (MinIO, Backblaze B2, Cloudflare R2, DigitalOcean Spaces, …) are supported.

> **Electron only** — this provider is not available in browser/web mode.

### How it works

1. The Electron main process generates a presigned URL (valid 60 s) for PUT, GET, or HEAD.
2. The renderer fetches the presigned URL and performs the HTTP operation directly with the bucket.
3. The object key is `{prefix}{workspaceId}.json` (default prefix: `apilix/`).

> S3 note: default presigned URL writes are not inherently conditional. If strict optimistic locking is required, prefer Git/HTTP/Team providers or an HTTP backend that enforces version checks.

### IAM permissions required (AWS S3)

```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"],
  "Resource": "arn:aws:s3:::your-bucket-name/apilix/*"
}
```

### Field reference

| Field | Required | Notes |
|---|:---:|---|
| Endpoint URL | — | Leave blank for AWS S3. Set to the server URL for S3-compatible services, e.g. `http://localhost:9000` |
| Bucket | ✅ | Bucket name, e.g. `my-apilix-bucket` |
| Region | — | AWS region, e.g. `us-east-1`. Optional for S3-compatible services |
| Prefix | — | Key prefix, defaults to `apilix/` |
| Access Key ID | ✅ | AWS IAM credential or S3-compatible access key, stored encrypted |
| Secret Access Key | ✅ | AWS IAM credential or S3-compatible secret key, stored encrypted |

### Step-by-step setup (AWS S3)

1. Create an S3 bucket in the AWS console.
2. Create an IAM user (or role) with the minimal policy above.
3. Generate an Access Key ID and Secret Access Key for that user.
4. Open **Manage Workspaces → Sync → S3 Storage**.
5. Leave **Endpoint URL** blank. Fill in Bucket, Region, Access Key ID, and Secret Access Key.
6. Click **Save config**, then **Push ↑** to upload the workspace. Verify the object appears in the S3 console at `{prefix}{workspaceId}.json`.
7. On another machine, fill in the same credentials and click **Pull ↓**.

### Step-by-step setup (MinIO / S3-compatible)

1. Start MinIO (e.g. `docker run -p 9000:9000 minio/minio server /data`).
2. Create a bucket and generate an Access Key + Secret Key in the MinIO console.
3. Open **Manage Workspaces → Sync → S3 Storage**.
4. Set **Endpoint URL** to your MinIO server URL (e.g. `http://localhost:9000`).
5. Fill in Bucket, Access Key ID, and Secret Access Key. Region is optional.
6. Click **Test connection** to verify, then **Save config** and **Push ↑**.

### Sharing with teammates

All teammates must fill in the same bucket, endpoint, and credentials. To restrict write access, create separate IAM policies — editors get `s3:PutObject`, viewers get only `s3:GetObject` and `s3:HeadObject`.

---

## 8. Sync provider: HTTP Endpoint

Pushes and pulls workspace JSON to/from any HTTP endpoint that you control. Useful for:

- A company's own sync microservice
- A serverless function (AWS Lambda, Cloudflare Workers, etc.)
- Any storage-as-a-service with an HTTP API

### Expected API contract

Your endpoint must implement these three HTTP operations:

| Operation | Method | Request | Response |
|---|---|---|---|
| Push | `PUT {endpoint}` | JSON body `{ "data": WorkspaceData, "lastModified": "ISO string", "expectedVersion"?: string }` and optional `If-Match` header | Any 2xx |
| Pull | `GET {endpoint}` | No body | JSON `{ "data": WorkspaceData }` or `404` |
| Timestamp | `HEAD {endpoint}` | No body | `Last-Modified`/`X-Last-Modified` and optional `ETag`/`X-Version` header |

Returning `404` on GET signals an empty remote (nothing to pull) — this is not treated as an error.

To support stale-apply recovery, return:

- `409` with body `{ "code": "STALE_VERSION", "expectedVersion": "...", "currentVersion": "..." }` when `If-Match` / `expectedVersion` does not match,
- a version header (`ETag` or `X-Version`) on GET/HEAD responses.

### Field reference

| Field | Required | Notes |
|---|:---:|---|
| Endpoint URL | ✅ | Full URL, e.g. `https://api.example.com/workspaces/prod` |
| Bearer Token | — | Sent as `Authorization: Bearer <token>` if provided |

### Step-by-step setup

1. Deploy your endpoint (see minimal example below).
2. Open **Manage Workspaces → Sync → HTTP Endpoint**.
3. Enter the endpoint URL and an optional bearer token.
4. Click **Save config**, then **Push ↑** to upload.

### Minimal Node.js endpoint example

```js
const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));

let store = null; // replace with a real database

app.put('/workspace', (req, res) => {
  store = req.body;
  res.set('Last-Modified', new Date().toUTCString()).json({ ok: true });
});

app.get('/workspace', (req, res) => {
  if (!store) return res.status(404).json({ error: 'empty' });
  res.set('Last-Modified', store.lastModified ?? new Date().toUTCString()).json(store);
});

app.head('/workspace', (req, res) => {
  if (!store) return res.status(404).end();
  res.set('Last-Modified', store.lastModified ?? new Date().toUTCString()).end();
});

app.listen(4000);
```

---

## 9. Sync provider: Team Server

Syncs with the self-hosted Apilix team server. Unlike the other providers, the team server enforces **role-based access control** — different team members can have different permissions on the same workspace.

### Field reference

| Field | Required | Notes |
|---|:---:|---|
| Server URL | ✅ | Base URL, e.g. `https://apilix.yourcompany.com` |
| Server Workspace ID | ✅ | The `id` returned when the workspace was created on the server |
| JWT Token | ✅ | Personal session token — 30-day expiry |

### Step-by-step setup

1. Start the team server (see [Section 10](#10-team-server-setup--management)).
2. The admin creates a workspace on the server (see API examples in Section 10).
3. The admin shares the **Server Workspace ID** and **Server URL** with team members.
4. Each team member calls `POST /auth/login` to get their JWT token.
5. In Apilix: **Manage Workspaces → Sync → Team Server** → enter Server URL, Server Workspace ID, JWT Token.
6. Click **Test connection** in the **Team** tab to verify access.
7. Editors click **Push ↑** / **Pull ↓** to sync; viewers can only **Pull ↓**.

---

## 10. Team server setup & management

The team server is a standalone Express application available as the `apilix-team-server` project. It runs on its own port and is completely separate from the main Apilix API server.

### Starting the server

See the `apilix-team-server` project for full setup and deployment instructions.

```bash
git clone https://github.com/your-org/apilix-team-server
cd apilix-team-server
npm install
npm start
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `TEAM_PORT` | `3003` | Port to listen on |
| `TEAM_DATA_DIR` | `~/.apilix-team` | Root directory for all team data |
| `ADMIN_EMAIL` | — | Email of the bootstrap admin (created on first start only) |
| `ADMIN_PASSWORD` | — | Password of the bootstrap admin |

Example with a custom port and data directory:

```bash
TEAM_PORT=8080 \
TEAM_DATA_DIR=/var/apilix-team \
ADMIN_EMAIL=admin@yourcompany.com \
ADMIN_PASSWORD=s3cr3t \
node index.js
```

### Data layout

```
{TEAM_DATA_DIR}/team/
  users.json              ← { [userId]: { id, name, email, passwordHash, role } }
  workspaces.json         ← { [workspaceId]: { id, name, ownerId, createdAt, members: {[userId]: role} } }
  .secret                 ← JWT signing secret (auto-generated, chmod 600)
  data/
    {workspaceId}.json    ← { data: WorkspaceData, lastModified: ISO string }
```

### Security

- Passwords are hashed with **bcrypt** (if `bcryptjs` is available) or SHA-512 with a random salt as fallback.
- The JWT secret is generated once with `crypto.randomBytes(48)` and stored at mode `0o600`. Rotating it invalidates all existing tokens.
- JWT tokens expire after **30 days**.

### Role hierarchy

```
owner  >  editor  >  viewer
```

| Permission | viewer | editor | owner |
|---|:---:|:---:|:---:|
| Pull workspace data | ✅ | ✅ | ✅ |
| Push workspace data | ✗ | ✅ | ✅ |
| Add / update members | ✗ | ✗ | ✅ |
| Remove members | ✗ | ✗ | ✅ |
| Delete workspace | ✗ | ✗ | ✅ |

The workspace creator is automatically the **owner**. The bootstrap admin is a global owner.

### Full API reference

All routes except `/auth/login` and `/health` require:
```
Authorization: Bearer <jwt-token>
```

#### Authentication

```
POST /auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "secret" }

→ 200 { "token": "eyJ...", "user": { "id", "name", "email", "role" } }
→ 401 { "error": "Invalid credentials" }
```

#### Workspace management

```
GET  /workspaces
→ 200 { "workspaces": [{ id, name, ownerId, createdAt, role, membersCount }] }

POST /workspaces
{ "name": "My Workspace" }
→ 201 { "workspace": { id, name, ownerId, createdAt, members: {} } }

GET  /workspaces/:id
→ 200 { "workspace": { ...meta, role } }
→ 403 No access
→ 404 Not found

DELETE /workspaces/:id         (owner only)
→ 200 { "ok": true }
→ 403 Owner only
```

#### Member management (owner only)

```
PUT /workspaces/:id/members
{ "userId": "<userId>", "role": "editor" | "viewer" }
→ 200 { "ok": true }
→ 400 userId and role required

DELETE /workspaces/:id/members/:uid
→ 200 { "ok": true }
→ 403 Owner only
```

#### Workspace data

```
HEAD /workspaces/:id/data      (viewer+)
→ 200  X-Last-Modified: <ISO string>
→ 404  No data yet

GET  /workspaces/:id/data      (viewer+)
→ 200 { "data": WorkspaceData }  (X-Last-Modified header set)
→ 404 No data yet

PUT  /workspaces/:id/data      (editor+)
{ "data": WorkspaceData }
→ 200 { "ok": true, "lastModified": "..." }
→ 400 data is required
→ 403 Requires role: editor
```

#### Health check

```
GET /health
→ 200 { "status": "ok" }
```

### Administration walkthrough (curl)

```bash
# 1. Log in as admin
TOKEN=$(curl -s -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourcompany.com","password":"s3cr3t"}' \
  | jq -r .token)

# 2. Create a workspace
WS_ID=$(curl -s -X POST http://localhost:3003/workspaces \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Project Alpha"}' \
  | jq -r .workspace.id)
echo "Workspace ID: $WS_ID"

# 3. Invite a team member as editor
# First, find or register the member's user ID
curl -X PUT http://localhost:3003/workspaces/$WS_ID/members \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"<member-user-id>\",\"role\":\"editor\"}"

# 4. Downgrade to viewer
curl -X PUT http://localhost:3003/workspaces/$WS_ID/members \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"<member-user-id>\",\"role\":\"viewer\"}"

# 5. Remove a member
curl -X DELETE http://localhost:3003/workspaces/$WS_ID/members/<member-user-id> \
  -H "Authorization: Bearer $TOKEN"

# 6. Delete the workspace
curl -X DELETE http://localhost:3003/workspaces/$WS_ID \
  -H "Authorization: Bearer $TOKEN"
```

### Deploying behind a reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name apilix.yourcompany.com;

    ssl_certificate     /etc/ssl/certs/apilix.crt;
    ssl_certificate_key /etc/ssl/private/apilix.key;

    location / {
        proxy_pass         http://127.0.0.1:3003;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
    }
}
```

### Running as a systemd service (Linux)

```ini
[Unit]
Description=Apilix Team Server
After=network.target

[Service]
Type=simple
User=apilix
WorkingDirectory=/opt/apilix-team-server
ExecStart=/usr/bin/node index.js
Restart=on-failure
Environment=TEAM_PORT=3003
Environment=TEAM_DATA_DIR=/var/apilix-team
Environment=ADMIN_EMAIL=admin@yourcompany.com
Environment=ADMIN_PASSWORD=changeme

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable apilix-team
sudo systemctl start apilix-team
```

---

## 11. Conflict resolution

A conflict occurs when the remote copy was modified after the local copy was last synced. This typically happens when multiple collaborators push independently without pulling first.

### Detection

Before every pull the sync engine compares:
- **Remote timestamp** — `Last-Modified` / `X-Last-Modified` header (or git commit time)
- **Local `lastSyncedAt`** — stored in sync metadata

If the remote timestamp is newer, a `ConflictError` is raised and the merge review flow starts.

### Three-way merge flow

1. Pull remote state and version metadata.
2. Load the merge-base snapshot (`lastMergeBaseSnapshotId`) when available.
3. Build a three-way merge result (`base` + `local` + `remote`).
4. Open conflict UI with request-level and text-level conflicts.
5. Apply merged output using provider optimistic write (if supported).

### Stale apply recovery

If the remote changes during merge apply:

1. Provider returns `409 STALE_VERSION` (when supported).
2. Apilix fetches the latest remote snapshot.
3. Apilix rebases the user-merged candidate against the new remote.
4. Merge modal reopens with updated conflicts.

### Resolution options

| Choice | Effect |
|---|---|
| **Apply Merged** | Applies the reviewed merge result to remote and local workspace. |
| **Keep All Remote** | Replace local with remote during conflict handling. |
| **Keep All Local** | Abort remote adoption and keep local state. |
| **Use Remote / Keep Local** (fallback banner) | Legacy fallback when merge package cannot be constructed. |

### Best practices to avoid conflicts

- **Pull before you Push** — always pull the latest version before making changes and pushing.
- **Use the team server** — it provides per-user sessions so conflicts are easier to coordinate.
- **Prefer versioned providers for high-concurrency edits** — Git, HTTP, and Team support strict stale-version checks.
- **One writer at a time on S3** — unless your backend adds conditional write enforcement.
- **Use workspaces as branches** — duplicate your workspace before making large changes, then merge manually.

---

## 12. Choosing the right collaboration solution

| Scenario | Recommended provider |
|---|---|
| Solo use, backup only | **Git** (private repo) or **S3** |
| Two developers sharing occasionally | **Git** (HTTPS + PAT) |
| Small team with shared AWS infrastructure | **S3** |
| Team with role-based access needs | **Team Server** |
| CI/CD pipeline or custom integration | **HTTP Endpoint** |
| Offline / air-gapped environment | **Git** (self-hosted Gitea) or **Team Server** (local network) |

### Feature comparison

| | Git | S3 | HTTP | Team Server |
|---|:---:|:---:|:---:|:---:|
| Requires Electron | ✗ | ✅ | ✗ | ✗ |
| Requires git on server | ✅ | ✗ | ✗ | ✗ |
| Full version history | ✅ | ✗ | ✗ | ✗ |
| Optimistic conditional writes | ✅ | ⚠ | ✅ | ✅ |
| Role-based access control | ✗ | ✗* | ✗* | ✅ |
| Self-hostable | ✅ | ✗† | ✅ | ✅ |
| No third-party dependency | ✗‡ | ✗ | ✅ | ✅ |
| Conflict detection | ✅ | ✅ | ✅ | ✅ |
| Three-way merge UI | ✅ | ✅ | ✅ | ✅ |
| Stale-apply rebase recovery | ✅ | ⚠ | ✅ | ✅ |

\* IAM policies can provide coarse access control at the infrastructure level.  
† MinIO and other S3-compatible services are supported via the optional Endpoint URL field.  
‡ Git requires a remote host (GitHub, GitLab, Gitea, etc.).
⚠ Supported only when the backing implementation enforces/returns version constraints.
