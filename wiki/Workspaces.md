# Workspaces

A **workspace** is the top-level isolation unit in Apilix. Everything you see in the UI — collections, environments, variables, cookies, and mock server routes — belongs to the active workspace. Switching workspaces replaces the entire UI context instantly.

This page covers creating and managing workspaces, the automatic snapshot history, and all four sync providers (Git, S3, HTTP Endpoint, Team Server), including conflict resolution.

---

## Table of Contents

1. [What a Workspace Contains](#what-a-workspace-contains)
2. [Managing Workspaces](#managing-workspaces)
3. [Storage Layout](#storage-layout)
4. [Automatic Snapshot History](#automatic-snapshot-history)
5. [Sync Overview](#sync-overview)
6. [Sync Provider: Git Repository](#sync-provider-git-repository)
7. [Sync Provider: Amazon S3 / S3-Compatible](#sync-provider-amazon-s3--s3-compatible)
8. [Sync Provider: HTTP Endpoint](#sync-provider-http-endpoint)
9. [Sync Provider: Team Server](#sync-provider-team-server)
10. [Team Server Setup & Administration](#team-server-setup--administration)
11. [Conflict Resolution](#conflict-resolution)
12. [Choosing the Right Provider](#choosing-the-right-provider)

---

## What a Workspace Contains

| Contents | Description |
|---|---|
| Collections & requests | All folders and HTTP requests |
| Environments | Named variable sets, selectable per workspace |
| Global variables | Cross-collection key/value store |
| Collection variables | Variables scoped to a specific collection |
| Cookie jar | Per-domain cookies persisted across requests |
| Mock server | Routes, port setting, and traffic log |

Each workspace has the following metadata:

| Field | Description |
|---|---|
| `id` | Auto-generated UUID — stable identifier used for file names and sync |
| `name` | Display name |
| `color` | Hex accent colour shown in the workspace switcher |
| `createdAt` | ISO timestamp of creation |
| `type` | `local` (default) or `team` (connected to a team server) |
| `role` | For team workspaces: `owner`, `editor`, or `viewer` |

---

## Managing Workspaces

Open the workspace manager by clicking the gear icon next to the workspace name in the sidebar, or via **Workspace Switcher → Manage Workspaces**.

![Workspace manager — Workspaces tab](images/workspaces-manager.png)

### Available actions

| Action | How |
|---|---|
| **Switch** | Click the workspace name in the list |
| **Create** | Click **+ New workspace** — creates an empty workspace and activates it |
| **Rename** | Click the ✏ pencil icon next to any workspace |
| **Change accent colour** | Click any colour dot on the left side of a workspace row |
| **Duplicate** | Click ⧉ — deep-clones all collections, environments, and variables into a new workspace with the same IDs; immediately activates the clone |
| **Empty workspace** | Click ⊘ — removes all collections from the workspace after confirmation; environments, variables, and mock routes are kept |
| **Delete** | Click 🗑 — at least one other workspace must exist |
| **Open data folder** | Click **Open data folder ↗** to reveal the Electron userData directory in the system file manager (desktop only) |

### Creating a workspace

A new workspace starts completely empty. After creation you can:
- Import a Postman collection, OpenAPI spec, or other format via **Import**
- Create collections manually
- Pull data from a configured sync provider

### Duplicating a workspace

Duplication is useful for creating a staging or testing copy of a live workspace. All IDs are preserved in the clone. The duplicate is immediately activated — the original workspace is unchanged.

### Emptying a workspace

The ⊘ button removes every collection from a workspace without deleting the workspace itself. A confirmation prompt is shown before any data is removed.

**What is cleared:**
- All collections and their requests
- Collection-scoped variable overrides
- All open request tabs

**What is kept:**
- Environments and environment variables
- Global variables
- Cookie jar
- Mock server routes and collections

If the emptied workspace is the currently active one, all open tabs are closed immediately. For inactive workspaces the data is zeroed in storage; no UI state changes occur.

---

## Storage Layout

### Desktop (Electron)

Data lives inside the system app-data directory:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Apilix/` |
| Windows | `%APPDATA%\Apilix\` |
| Linux | `~/.config/Apilix/` |

```
{userData}/
  workspaces.json              ← manifest: list of workspaces + activeWorkspaceId
  settings.json                ← app-level settings (theme, proxy, etc.)
  sync-config.json             ← per-workspace sync credentials (encrypted)
  sync-activity.json           ← sync event log (newest first, max 100 entries)
  workspaces/
    {workspaceId}.json         ← workspace data (collections, envs, variables, …)
    {workspaceId}/
      history.json             ← snapshot index (newest first, max 50 entries)
      snapshots/
        {snapshotId}.json      ← full workspace data blob at a point in time
```

> **Credential security:** Sync credentials (tokens, secret keys) are encrypted with Electron's `safeStorage` API before being written to `sync-config.json`. They are never stored in plaintext on disk.

### Web / Browser Mode

All data is stored in `localStorage`:

| Key | Content |
|---|---|
| `apilix_workspaces` | Workspace manifest |
| `apilix_workspace_{id}` | Workspace data per ID |
| `apilix_settings` | App settings |
| `apilix_sync_config` | Sync credentials (plaintext — dev only) |
| `apilix_sync_activity` | Per-workspace sync event log |

> **Warning:** `localStorage` is capped at ~5 MB and is cleared when the browser cache is cleared. Use desktop mode for reliable, long-term persistence. In browser mode, sync credentials are stored in plaintext — do not use sensitive credentials in this mode.

---

## Automatic Snapshot History

> **Looking for request history?** This section covers the *workspace snapshot* history — a timeline of collection/environment saves that lets you roll back the entire workspace. For a log of individual HTTP requests you've sent, see [Request History](Request-History).

Apilix saves a snapshot of the active workspace automatically after every change (debounced ~300 ms after the last edit). No manual action is needed.

![Workspace manager — History tab](images/workspaces-history-tab.png)

### Viewing and restoring snapshots

Open **Manage Workspaces → History** to see the timeline, newest first. Each entry shows:

- Auto-generated summary (e.g. `3 collection(s), auto-save`)
- Timestamp (local time)
- Number of collections in the snapshot

Click any entry to expand it, then click **Restore this snapshot** to roll the workspace back to that exact state.

> **Before restoring:** The current workspace state is overwritten immediately. If you need to preserve it, duplicate the workspace first.

### Limits

- Up to **50 snapshots** per workspace are kept. The oldest is automatically deleted when the limit is reached.
- Snapshots are stored locally — they are not pushed when you sync to a remote provider.

### Snapshot storage

```
{userData}/workspaces/{workspaceId}/
  history.json            ← index with summary + timestamp metadata
  snapshots/
    {snapshotId}.json     ← full workspace data blob
```

---

## Sync Overview

The **Sync** tab in **Manage Workspaces** connects a workspace to a remote provider for backup or team collaboration. All four providers share the same set of operations:

| Button | Operation | Description |
|---|---|---|
| **Push ↑** | Upload | Serialises the current workspace and sends it to the remote. Config is saved first. |
| **Pull ↓** | Download | Fetches remote data and replaces the local workspace. Config is saved first. |
| **Save config** | Persist | Saves the connection fields to disk without pushing or pulling. |
| **Import once ↓** | One-shot clone | Pulls once without persisting the config — useful for a one-time import. |

![Workspace manager — Sync tab](images/workspaces-sync-tab.png)

### Sync activity log

The Sync tab shows a **Recent sync activity** panel with a log of the last 100 events per workspace:

- Push / Pull / Import outcomes
- Conflict detection events
- Merge review open / apply events
- Stale-apply rebase attempts
- Save-config events

---

## Sync Provider: Git Repository

Stores the workspace as a `workspace.json` file inside a local git clone that is pushed to / pulled from any standard git remote (GitHub, GitLab, Gitea, etc.).

### How it works

1. On first push, Apilix initialises a bare git repo at `{userData}/git-sync/workspaces/{workspaceId}/`.
2. The workspace JSON is written to `workspace.json` and committed.
3. The commit is pushed to the configured remote using `simple-git`.
4. On pull, the remote is fetched and `workspace.json` is read back.

### Prerequisites

- **Git must be installed** on the machine running the Apilix server — verify with `git --version`.
- A remote repository on any git host. The remote should be **empty** (no initial commit) for a clean first push.

### Field reference

| Field | Required | Notes |
|---|:---:|---|
| Remote URL | ✅ | HTTPS or SSH, e.g. `https://github.com/user/repo.git` |
| Branch | — | Defaults to `main` if left blank |
| Username | — | For HTTPS auth only; not needed for SSH |
| Token / Password | — | Personal Access Token (recommended over password) |
| Author Name | ⚠ | Required for commits if `git config --global user.name` is not set |
| Author Email | ⚠ | Required for commits if `git config --global user.email` is not set |

### Generating a Personal Access Token

**GitHub:**
1. Go to **Settings → Developer settings → Personal access tokens → Generate new token (classic)**.
2. Select the `repo` scope.
3. Copy the token and paste it into the **Token** field.

**GitLab:**
1. Go to **User Settings → Access Tokens**.
2. Select `read_repository` + `write_repository` scopes.
3. Copy the token.

### Step-by-step setup

1. Create an **empty** repo on your git host (no README, no `.gitignore`).
2. Generate a PAT.
3. Open **Manage Workspaces → Sync → Git Repository**.
4. Fill in Remote URL, Branch, Username, Token, Author Name, and Author Email.
5. Click **Save config**.
6. Click **Push ↑** — this initialises the local git repo and uploads `workspace.json`.
7. On another machine: fill in the same fields → **Save config** → **Pull ↓**.

### Common scenarios

| Scenario | Action |
|---|---|
| You made changes locally | **Push ↑** |
| A teammate pushed changes | **Pull ↓** |
| First time on a new machine | Configure fields → **Pull ↓** |
| One-off clone without saving credentials | **Import once ↓** |
| Remote already has existing commits | **Import once ↓** first, then **Push ↑** |

### Authentication notes

When both Username and Token are provided, Apilix embeds the credentials in the remote URL server-side:
```
https://{username}:{token}@github.com/user/repo.git
```
The credential-embedded URL is never stored on disk. For SSH remotes (`git@github.com:user/repo.git`), leave Username and Token blank — git will use the system SSH agent or `~/.ssh/config`.

---

## Sync Provider: Amazon S3 / S3-Compatible

Stores the workspace as a JSON object in an S3 or S3-compatible bucket (MinIO, Backblaze B2, Cloudflare R2, DigitalOcean Spaces, etc.). AWS credentials never reach the renderer — presigned URLs are generated inside the Electron main process.

> **Electron (desktop) only** — this provider is not available in web/browser mode.

### How it works

1. The Electron main process generates a presigned URL (valid 60 s) for PUT, GET, or HEAD.
2. The renderer uses the presigned URL to perform the HTTP operation directly against S3.
3. The object key is `{prefix}{workspaceId}.json` (default prefix: `apilix/`).

### IAM permissions required

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
| Endpoint URL | — | Leave blank for AWS S3. Set to server URL for S3-compatible services, e.g. `http://localhost:9000` |
| Bucket | ✅ | Bucket name, e.g. `my-apilix-bucket` |
| Region | — | AWS region, e.g. `us-east-1`. Optional for S3-compatible services |
| Prefix | — | Object key prefix, defaults to `apilix/` |
| Access Key ID | ✅ | IAM credential — stored encrypted on disk |
| Secret Access Key | ✅ | IAM credential — stored encrypted on disk |

### Step-by-step setup

**AWS S3:**

1. Create an S3 bucket in the AWS console.
2. Create an IAM user with the minimal policy above and generate credentials.
3. Open **Manage Workspaces → Sync → S3 Storage**.
4. Leave **Endpoint URL** blank. Fill in Bucket, Region, Access Key ID, and Secret Access Key.
5. Click **Test connection** to verify, then **Save config**.
6. Click **Push ↑** and verify the object appears in the S3 console at `{prefix}{workspaceId}.json`.
7. On another machine: fill in the same credentials → **Pull ↓**.

**MinIO / S3-compatible:** See [S3-compatible storage](#s3-compatible-storage) below.

### S3-compatible storage

Any S3-compatible service (MinIO, Backblaze B2, DigitalOcean Spaces, Cloudflare R2) works natively. Set the optional **Endpoint URL** field to your service's server URL (e.g. `http://localhost:9000`). The `forcePathStyle` option is set automatically when an endpoint is provided, which is required by MinIO and most self-hosted services.

**MinIO quick-start:**

1. Run MinIO: `docker run -p 9000:9000 minio/minio server /data`
2. Create a bucket and generate credentials in the MinIO console (`http://localhost:9001`).
3. Open **Manage Workspaces → Sync → S3 Storage**, set **Endpoint URL** to `http://localhost:9000`.
4. Fill in Bucket, Access Key ID, and Secret Access Key (Region is optional).
5. Click **Test connection** to verify, then **Save config** and **Push ↑**.

> **Note on conditional writes:** Default S3 presigned PUT operations are not inherently conditional. For strict optimistic locking, prefer Git, HTTP Endpoint, or Team Server providers.

---

## Sync Provider: HTTP Endpoint

Pushes and pulls workspace JSON to/from any HTTP endpoint you control — a custom microservice, a serverless function (AWS Lambda, Cloudflare Workers), or any storage API.

### Expected API contract

| Operation | Method | Request | Success Response |
|---|---|---|---|
| Push | `PUT {endpoint}` | JSON body `{ "data": WorkspaceData, "lastModified": "ISO", "expectedVersion"?: string }` | Any 2xx |
| Pull | `GET {endpoint}` | No body | `200 { "data": WorkspaceData }` or `404` (empty remote) |
| Timestamp check | `HEAD {endpoint}` | No body | `Last-Modified` / `X-Last-Modified` header |

To support stale-apply conflict recovery, return:
- `409` with body `{ "code": "STALE_VERSION" }` when `expectedVersion` does not match.
- A version header (`ETag` or `X-Version`) on GET/HEAD responses.

A `404` on GET signals an empty remote — Apilix treats this as "nothing to pull" rather than an error.

### Field reference

| Field | Required | Notes |
|---|:---:|---|
| Endpoint URL | ✅ | Full URL, e.g. `https://api.example.com/workspaces/prod` |
| Bearer Token | — | Sent as `Authorization: Bearer <token>` if provided |

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

## Sync Provider: Team Server

The Team Server provider syncs with a self-hosted `apilix-team-server` instance that enforces **role-based access control** — different team members can have different permissions on the same workspace.

### Field reference

| Field | Required | Notes |
|---|:---:|---|
| Server URL | ✅ | Base URL, e.g. `https://apilix.yourcompany.com` |
| Server Workspace ID | ✅ | The `id` returned when the workspace was created on the server |
| JWT Token | ✅ | Personal session token — 30-day expiry, obtained via `POST /auth/login` |

### Step-by-step setup

1. Start the team server (see [Team Server Setup](#team-server-setup--administration)).
2. The admin creates a workspace on the server and shares the workspace ID and server URL with team members.
3. Each member calls `POST /auth/login` to get their JWT.
4. In Apilix: **Manage Workspaces → Sync → Team Server** → enter Server URL, Workspace ID, and JWT Token.
5. Click **Test connection** in the **Team** tab to verify.
6. Editors use **Push ↑** / **Pull ↓**; viewers can only **Pull ↓**.

---

## Team Server Setup & Administration

The team server is a standalone Express app (`apilix-team-server`). It runs on its own port, independent of the main Apilix API server.

### Starting the server

```bash
git clone https://github.com/your-org/apilix-team-server
cd apilix-team-server
npm install
npm start
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `TEAM_PORT` | `3003` | HTTP port |
| `TEAM_DATA_DIR` | `~/.apilix-team` | Root data directory |
| `ADMIN_EMAIL` | — | Bootstrap admin email (first-start only) |
| `ADMIN_PASSWORD` | — | Bootstrap admin password |

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
  workspaces.json         ← { [workspaceId]: { id, name, ownerId, members } }
  .secret                 ← JWT signing secret (auto-generated, chmod 600)
  data/
    {workspaceId}.json    ← { data: WorkspaceData, lastModified: ISO string }
```

### Security

- Passwords hashed with **bcrypt** (SHA-512 + random salt as fallback).
- JWT secret: generated once with `crypto.randomBytes(48)`, stored at mode `0o600`. Rotating it invalidates all existing tokens.
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

# 3. Invite a member as editor
curl -X PUT http://localhost:3003/workspaces/$WS_ID/members \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<member-user-id>","role":"editor"}'

# 4. Downgrade to viewer
curl -X PUT http://localhost:3003/workspaces/$WS_ID/members \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<member-user-id>","role":"viewer"}'

# 5. Remove a member
curl -X DELETE http://localhost:3003/workspaces/$WS_ID/members/<member-user-id> \
  -H "Authorization: Bearer $TOKEN"

# 6. Delete the workspace
curl -X DELETE http://localhost:3003/workspaces/$WS_ID \
  -H "Authorization: Bearer $TOKEN"
```

### Deploying behind nginx

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

## Conflict Resolution

A conflict occurs when the remote was modified after the local copy was last synced — typically when multiple collaborators push independently without pulling first.

![Conflict merge modal](images/workspaces-conflict-modal.png)

### Detection

Before every pull, the sync engine compares:
- **Remote timestamp** — `Last-Modified` / `X-Last-Modified` header (or git commit time)
- **Local `lastSyncedAt`** — stored in sync metadata

If the remote is newer, a conflict is raised and the merge review flow starts.

### Three-way merge flow

1. Pull the remote state and version metadata.
2. Load the merge-base snapshot (`lastMergeBaseSnapshotId`) when available.
3. Build a three-way diff: **base** (last common snapshot) + **local** + **remote**.
4. Open the **Conflict Merge Modal** — shows request-level and code-level conflicts side by side.
5. Apply the merged result using an optimistic write (where the provider supports it).

### Stale apply recovery

If the remote changes while you are reviewing the merge:

1. The provider returns `409 STALE_VERSION`.
2. Apilix fetches the newest remote snapshot.
3. Your merged candidate is rebased against the new remote.
4. The merge modal reopens with updated conflicts.

### Resolution options

| Choice | Effect |
|---|---|
| **Apply Merged** | Applies your reviewed merge result to both the remote and local workspace |
| **Keep All Remote** | Replaces local with the remote version entirely |
| **Keep All Local** | Aborts the pull and keeps the local state unchanged |
| **Use Remote / Keep Local** (fallback) | Legacy binary choice when the merge base snapshot is unavailable |

### Best practices

- **Pull before you Push** — always pull the latest version before pushing changes.
- **Use the Team Server** for high-concurrency teams — it provides per-user sessions and strict conditional writes.
- **Prefer Git / HTTP / Team Server** for optimistic locking — S3 does not guarantee conditional writes by default.
- **Use workspaces as branches** — duplicate your workspace before large changes, then merge manually.

---

## Choosing the Right Provider

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
| Conflict detection | ✅ | ✅ | ✅ | ✅ |
| Three-way merge UI | ✅ | ✅ | ✅ | ✅ |
| Stale-apply rebase recovery | ✅ | ⚠ | ✅ | ✅ |

\* IAM / bearer token policies can provide coarse access control at the infrastructure level.  
† S3-compatible self-hosted (MinIO) works but requires manual endpoint configuration.  
⚠ Supported only when the backing implementation enforces / returns version constraints.

---

## See Also

- [Getting Started](Getting-Started) — first workspace walkthrough
- [Sync & Collaboration](Sync-and-Collaboration) — deep dive into push/pull workflows and the sync activity log
- [Collections & Requests](Collections-and-Requests) — building and organising requests inside a workspace
- [Variables & Environments](Variables-and-Environments) — environments and variable scopes within a workspace
