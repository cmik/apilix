# Sync & Collaboration

Apilix workspaces can be synced to a remote provider so that your collections, environments, and settings are available on multiple machines and can be shared with teammates. This page covers all four sync providers, conflict resolution, and team server administration.

> **S3 provider requires Electron (desktop app):** The S3 / S3-compatible provider generates presigned URLs via the Electron main process, so it only works in the desktop app. All other providers — Git, HTTP Endpoint, and Team Server — work in both desktop and web mode. In web mode, credentials are stored in plaintext `localStorage` — use desktop mode for production.

---

## Table of Contents

- [Sync \& Collaboration](#sync--collaboration)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Opening Sync Settings](#opening-sync-settings)
  - [Sync Operations](#sync-operations)
    - [Network Timeouts](#network-timeouts)
    - [Push Safety Checks](#push-safety-checks)
  - [Conflict Detection \& Resolution](#conflict-detection--resolution)
    - [Three-way Merge Modal](#three-way-merge-modal)
    - [Bulk Actions](#bulk-actions)
    - [Stale Apply Recovery](#stale-apply-recovery)
    - [Legacy Fallback](#legacy-fallback)
  - [Sync Activity Log](#sync-activity-log)
  - [Provider: Git Repository](#provider-git-repository)
    - [How it Works](#how-it-works)
    - [Prerequisites](#prerequisites)
    - [Field Reference](#field-reference)
    - [Generating a Personal Access Token](#generating-a-personal-access-token)
    - [Step-by-step Setup](#step-by-step-setup)
    - [Authentication](#authentication)
    - [Ongoing Usage](#ongoing-usage)
  - [Provider: Amazon S3 / S3-Compatible](#provider-amazon-s3--s3-compatible)
    - [How it Works (S3)](#how-it-works-s3)
    - [IAM Permissions Required](#iam-permissions-required)
    - [Field Reference (S3)](#field-reference-s3)
    - [Step-by-step Setup (S3)](#step-by-step-setup-s3)
    - [S3-compatible Storage (MinIO, etc.)](#s3-compatible-storage-minio-etc)
  - [Provider: HTTP Endpoint](#provider-http-endpoint)
    - [API Contract](#api-contract)
    - [Field Reference (HTTP)](#field-reference-http)
    - [Step-by-step Setup (HTTP)](#step-by-step-setup-http)
    - [Minimal Node.js Endpoint Example](#minimal-nodejs-endpoint-example)
  - [Provider: Team Server](#provider-team-server)
    - [How it Works (Team)](#how-it-works-team)
    - [Field Reference (Team)](#field-reference-team)
    - [Team Server Administration](#team-server-administration)
    - [Roles](#roles)
    - [Self-hosting the Team Server](#self-hosting-the-team-server)
  - [Remote Data Encryption](#remote-data-encryption)
  - [Sharing Sync Configuration](#sharing-sync-configuration)
    - [Exporting a sync config](#exporting-a-sync-config)
    - [Sharing policies](#sharing-policies)
    - [Embedding the remote passphrase](#embedding-the-remote-passphrase)
    - [Importing a sync config](#importing-a-sync-config)
    - [Shared workspace behavior](#shared-workspace-behavior)
  - [Provider Comparison](#provider-comparison)
  - [Three-Way Merge — Technical Reference](#three-way-merge--technical-reference)
    - [Pipeline Overview](#pipeline-overview)
    - [Differ — Request Identity and Change Classification](#differ--request-identity-and-change-classification)
    - [Merge Rules by Domain](#merge-rules-by-domain)
      - [Requests (`mergeRequestItem`)](#requests-mergerequestitem)
      - [Body — JSON Structural Merge](#body--json-structural-merge)
      - [Environments](#environments)
      - [Global Variables and Collection Variables](#global-variables-and-collection-variables)
      - [Mock Routes](#mock-routes)
      - [Fields Outside the Merge Pipeline](#fields-outside-the-merge-pipeline)
    - [Snapshot Ring Buffer](#snapshot-ring-buffer)
    - [Stale-Apply Cycle](#stale-apply-cycle)
  - [See Also](#see-also)

---

## Overview

All sync providers share the same workspace data model: collections, environments, global variables, mock server routes, and the cookie jar are all included in a single sync snapshot.

| Provider | Best for | Requires |
|---|---|---|
| **Git Repository** | Version-controlled history, PR reviews, GitHub/GitLab teams | Git installed on the machine |
| **Amazon S3 / S3-Compatible** | Cloud backup, simple multi-machine sharing; supports AWS S3 and self-hosted services (MinIO, Backblaze B2, Cloudflare R2) | S3-compatible bucket; Electron desktop app |
| **HTTP Endpoint** | Custom sync microservice, serverless function | A deployed HTTP endpoint you control |
| **Team Server** | Real-time collaboration, role-based access, no git knowledge required | A running Apilix Team Server instance |

![Sync settings panel](images/sync-overview.png)

---

## Opening Sync Settings

Click the **gear icon** next to the workspace name in the sidebar, then select the **Sync** tab in the Manage Workspaces modal.

Each workspace has independent sync configuration. The settings and credentials are stored per-workspace and are never shared between workspaces.

![Manage Workspaces — Sync tab](images/sync-settings-tab.png)

---

## Sync Operations

All four providers expose the same four actions:

| Button | Operation | Description |
|---|---|---|
| **Push ↑** | Upload | Serialise the current workspace and upload it to the remote. Credentials are saved first. |
| **Pull ↓** | Download | Check for conflicts, then download remote data and replace the local workspace. |
| **Save config** | Persist credentials | Save the connection fields to disk without pushing or pulling. |
| **Import once ↓** | One-time clone | Pull once without persisting the sync configuration — useful for cloning a workspace without setting up ongoing sync. |

> **Tip:** Use **Import once ↓** when you want to copy a colleague's workspace to your machine for a single session, or when the remote already has existing commits and you need to pull before your first push.

### Quick Sync (Toolbar)

The top-bar **Sync** button (`Cmd/Ctrl+Shift+S`) is a pull-first workflow:

1. Pull remote state first.
2. If local unsynced changes exist, run a three-way merge against the pulled remote snapshot.
3. If merge conflicts remain, open the merge modal and stop (no push is attempted).
4. If merge resolves cleanly, push the merged result (except read-only workspaces, which apply locally only).

This ordering reduces accidental overwrite risk by always reconciling with remote before upload.

### Network Timeouts

Every outbound sync request is subject to a client-side timeout. If the remote server does not respond within the limit, the operation is aborted and an error message is shown in the Sync tab.

| Provider | Timeout |
|---|---|
| Git Repository | **30 seconds** — the extra time accounts for server-side git network I/O |
| S3 / S3-compatible | **15 seconds** |
| HTTP Endpoint | **15 seconds** |
| Team Server | **15 seconds** |

The timeout applies to every operation: push, pull, timestamp check, state check, and connection test. If a sync operation times out, no data is modified — the local workspace remains unchanged.

> **If pushes or pulls time out consistently**, check that the remote host is reachable from your machine and that any reverse proxy (nginx, Caddy) has a `proxy_read_timeout` / `read_timeout` that is at least as long as the values above.

### Push Safety Checks

Before executing a push, Apilix runs the following safety checks to prevent accidental data loss:

#### Empty workspace guard

If the workspace has **no collections**, clicking **Push ↑** (or the toolbar **Sync** button) pauses and shows a confirmation dialog:

> *"You are about to push an empty workspace. This will overwrite the remote workspace and may cause data loss. Are you sure you want to continue?"*

| Action | Result |
|---|---|
| **Push anyway** | Push proceeds and the remote is overwritten with the empty workspace |
| **Cancel** | Push is aborted; the local workspace and remote are unchanged |

This guard applies to both the **Push ↑** button in the Sync tab and the toolbar **Sync** button (quick-sync path). It does **not** apply to the **Apply Merged** path — the merged result is always derived from existing remote + local data and is never empty.

---

## Conflict Detection & Resolution

Before every **Pull ↓**, Apilix compares the remote timestamp against the local sync metadata (`lastSyncedAt`). If the remote was modified after your last sync, a **conflict review** is triggered.

### Three-way Merge Modal

The merge modal uses three data sources:

| Pane | Source |
|---|---|
| **Base** | Last known common snapshot (`lastMergeBaseSnapshotId`) — the version both sides diverged from |
| **Local** | Current workspace state in the app |
| **Remote** | Latest data from the provider |

![Conflict merge modal — three-pane view](images/sync-conflict-merge.png)

The modal is divided into three columns:

- **Left** — Conflict navigator, grouped by domain (Requests, Collections, Environments, Global Variables, Mock Routes). An "unresolved" badge shows how many conflicts remain.
- **Centre** — Side-by-side comparison of the local value vs the remote value for the selected conflict, with the base value shown as a hint below.
- **Right** — Merged preview — the current resolved value. Editable in free-form mode.

**Conflict types detected:**

| Type | Description |
|---|---|
| `Field conflict` | The same field was modified on both sides |
| `Move vs edit` | One side moved/reordered; the other edited content |
| `Delete vs edit` | One side deleted the item; the other edited it |
| `Rename conflict` | Both sides renamed the same item to different names |
| `JSON key conflict` | Conflicting values at a specific JSON key |
| `Text merge conflict` | Fallback diff when JSON-level merge is not possible |

**Per-conflict actions:**

| Action | Result |
|---|---|
| **Take Local** | Resolve with the local value and advance to the next unresolved conflict |
| **Take Remote** | Resolve with the remote value and advance |
| **Edit** | Open the merged preview as a free-form text editor to write a custom value |
| Click resolved badge | Unresolve — reopen the conflict for re-review |

A **Filter: Unresolved only** toggle hides already-resolved conflicts to focus on what remains.

### Bulk Actions

| Button | Effect |
|---|---|
| **Keep All Local** | Resolve every conflict with the local value and close |
| **Keep All Remote** | Resolve every conflict with the remote value and close |
| **Apply Merged** | Apply the current mix of resolutions. Only enabled when all conflicts are resolved. |

> **Read-only workspaces:** In a workspace with the `readOnly` flag set (e.g. imported from a share package with **Force read-only**), clicking **Apply Merged** applies the merged result to the local workspace only — the push step is skipped. The local workspace is updated but the remote is not modified. This applies to both the full merge modal and the quick-sync merge path.

### Stale Apply Recovery

When **Apply Merged** is clicked, Apilix attempts an optimistic conditional write to the provider (using `If-Match` headers or `expectedVersion` parameters, depending on the provider). If another push arrived between the time you opened the merge modal and clicked Apply — making your base stale — the provider returns a `409 STALE_VERSION` error.

Apilix handles this automatically:

1. Fetches the newest remote state.
2. Rebuilds a fresh three-way merge package (new base → your local → newest remote).
3. Reopens the merge modal so you can review whatever new conflicts exist.

You never lose data in this scenario — the cycle simply repeats until your apply succeeds.

### Legacy Fallback

For providers configured before the three-way merge feature was introduced, or when base snapshot data is unavailable, the UI falls back to a simpler binary choice:

- **Use Remote** — overwrite local with remote data
- **Keep Local** — discard pull and keep the local state unchanged

---

## Sync Activity Log

The **Sync** tab shows a **Recent Sync Activity** section listing the last 100 sync events for the current workspace (newest first). Persisted in `sync-activity.json` (desktop) or `apilix_sync_activity` (browser mode).

| Event type | Description |
|---|---|
| `push` | Successful push to remote |
| `pull` | Successful pull and apply |
| `import-once` | One-time cloned without saving config |
| `conflict-detected` | Remote was newer — merge review triggered |
| `merge-applied` | Merged result applied successfully |
| `stale-rebase` | Stale apply detected — fresh merge rebuild triggered |
| `save-config` | Credentials saved |

---

## Provider: Git Repository

### How it Works

1. On first push, Apilix initialises a local bare git repository at `{userData}/git-sync/workspaces/{workspaceId}/`.
2. The workspace data is written to `workspace.json` and committed with the configured author name and email.
3. The commit is pushed to the configured remote using `simple-git` running server-side.
4. On pull, the remote is fetched and `workspace.json` is read back from the latest commit on the configured branch.

> Git commands run on the **server process** (not in the browser renderer), so no git credentials are ever exposed to the UI.

### Prerequisites

- **Git must be installed** on the machine running the Apilix server (`git --version` in a terminal to confirm).
- A remote repository on GitHub, GitLab, Gitea, Bitbucket, or any compatible host.
- The remote should be **empty** (no initial commit) for a clean first push.

### Field Reference

| Field | Required | Notes |
|---|:---:|---|
| Remote URL | ✅ | HTTPS or SSH URL, e.g. `https://github.com/user/repo.git` |
| Branch | — | Defaults to `main` if blank |
| Username | — | HTTPS auth only; leave blank for SSH |
| Token / Password | — | Personal Access Token used with Username |
| Author Name | ⚠ | Required for commits unless `git config --global user.name` is set system-wide |
| Author Email | ⚠ | Required for commits unless `git config --global user.email` is set system-wide |

### Generating a Personal Access Token

**GitHub:**
1. Settings → Developer settings → Personal access tokens → Generate new token (classic)
2. Select the `repo` scope (read/write repository access)
3. Copy the token into the **Token** field in Apilix

**GitLab:**
1. User Settings → Access Tokens
2. Select `read_repository` + `write_repository` scopes
3. Copy the token

**Gitea / other hosts:** Follow the host's documentation for generating a personal access token with repository read/write permissions.

### Step-by-step Setup

1. Create an **empty** repository on your git host (no README, no .gitignore, no commits).
2. Generate a PAT (see above).
3. Open **Manage Workspaces → Sync** and select **Git Repository**.
4. Fill in: Remote URL, Branch (e.g. `main`), Username, Token, Author Name, Author Email.
5. Click **Save config** to persist credentials.
6. Click **Push ↑** — the first push initialises the local clone and commits `workspace.json`.
7. On another machine, fill in the same credentials and click **Pull ↓**.

### Authentication

When Username and Token are both provided, Apilix embeds the credentials in the remote URL server-side:
```
https://{username}:{token}@github.com/user/repo.git
```
The credential-embedded URL is never stored to disk.

For **SSH remotes** (`git@github.com:user/repo.git`), leave Username and Token blank. The server-side git process uses the system's SSH agent or `~/.ssh/config`.

### Ongoing Usage

| Scenario | Action |
|---|---|
| You made changes locally | Push ↑ |
| A teammate pushed changes | Pull ↓ |
| First time on a new machine | Configure fields → Pull ↓ |
| One-off clone without saving credentials | Import once ↓ |
| Remote already has existing commits | Import once ↓ first, then Push ↑ |

---

## Provider: Amazon S3 / S3-Compatible

### How it Works (S3)

1. The Electron main process generates a presigned URL (valid 60 s) for PUT, GET, or HEAD operations.
2. The renderer performs the HTTP operation directly with S3 using the presigned URL.
3. AWS credentials never leave the Electron main process.
4. The workspace object key is `{prefix}{workspaceId}.json` (default prefix: `apilix/`).

> Like all sync providers, the S3 provider requires the Electron desktop app.

### IAM Permissions Required

Create an IAM user (or role) with the following minimal policy:

```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"],
  "Resource": "arn:aws:s3:::your-bucket-name/apilix/*"
}
```

For **viewer-only** teammates, grant only `s3:GetObject` and `s3:HeadObject`.

### Field Reference (S3)

| Field | Required | Notes |
|---|:---:|---|
| Endpoint URL | — | Leave blank for AWS S3. Set to server URL for S3-compatible services, e.g. `http://localhost:9000` |
| Bucket | ✅ | Bucket name, e.g. `my-apilix-bucket` |
| Region | — | AWS region, e.g. `us-east-1`. Optional for S3-compatible services |
| Prefix | — | Key prefix; defaults to `apilix/` |
| Access Key ID | ✅ | IAM credential, stored encrypted |
| Secret Access Key | ✅ | IAM credential, stored encrypted |

### Step-by-step Setup (S3)

**AWS S3:**

1. Create an S3 bucket in the AWS console (block all public access).
2. Create an IAM user/role with the minimal policy above.
3. Generate an Access Key ID and Secret Access Key.
4. Open **Manage Workspaces → Sync → S3 Storage**.
5. Leave **Endpoint URL** blank. Fill in Bucket, Region, Access Key ID, and Secret Access Key.
6. Click **Test connection** to verify, then **Save config**.
7. Click **Push ↑** — verify the object appears in the S3 console at `{prefix}{workspaceId}.json`.
8. Share the bucket name, region, prefix, and credentials with teammates; they click **Pull ↓** to get the workspace.

**MinIO / S3-compatible:** See [S3-compatible Storage](#s3-compatible-storage-minio-etc) below.

### S3-compatible Storage (MinIO, etc.)

The S3 provider supports any S3-compatible service by entering an **Endpoint URL**. When an endpoint is set, the AWS SDK is configured with `forcePathStyle: true` automatically, which is required by MinIO and most self-hosted services.

**Step-by-step (MinIO example):**

1. Start MinIO: `docker run -p 9000:9000 minio/minio server /data`
2. Open the MinIO console (`http://localhost:9001` by default), create a bucket, and generate an Access Key + Secret.
3. Open **Manage Workspaces → Sync → S3 Storage**.
4. Set **Endpoint URL** to `http://localhost:9000` (or your MinIO server URL).
5. Fill in Bucket, Access Key ID, and Secret Access Key. Region is optional.
6. Click **Test connection** to verify, then **Save config** and **Push ↑**.

Other S3-compatible services (Backblaze B2, Cloudflare R2, DigitalOcean Spaces) follow the same pattern — enter the provider’s endpoint URL and the credentials from your provider’s console.

> **Note on conditional writes:** Default presigned PUT operations are not inherently conditional. For strict optimistic locking, prefer Git, HTTP Endpoint, or Team Server providers.

---

## Provider: HTTP Endpoint

The HTTP Endpoint provider pushes and pulls workspace JSON to/from any HTTP endpoint you control — a microservice, a serverless function, or any storage API.

### API Contract

Your endpoint must implement three operations:

| Operation | Method | Request | Success Response |
|---|---|---|---|
| **Push** | `PUT {endpoint}` | JSON body `{ "data": WorkspaceData, "lastModified": "ISO string", "expectedVersion"?: string }` + optional `If-Match` header | Any `2xx` |
| **Pull** | `GET {endpoint}` | No body | `{ "data": WorkspaceData }` or `404` |
| **Timestamp** | `HEAD {endpoint}` | No body | `Last-Modified` or `X-Last-Modified` header; optionally `ETag` or `X-Version` header |

Returning `404` on GET signals an empty remote — treated as "nothing to pull", not an error.

**For optimistic locking support** (recommended), return:
- `409` with body `{ "code": "STALE_VERSION" }` when `expectedVersion` does not match the current version.
- A version header (`ETag` or `X-Version`) on GET/HEAD responses for stale-apply recovery.

### Field Reference (HTTP)

| Field | Required | Notes |
|---|:---:|---|
| Endpoint URL | ✅ | Full URL, e.g. `https://api.example.com/workspaces/my-project` |
| Bearer Token | — | Sent as `Authorization: Bearer <token>` if provided |

### Step-by-step Setup (HTTP)

1. Deploy an endpoint that satisfies the API contract above.
2. Open **Manage Workspaces → Sync → HTTP Endpoint**.
3. Enter the endpoint URL and optional bearer token.
4. Click **Save config**, then **Push ↑**.

### Minimal Node.js Endpoint Example

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

app.listen(4000, () => console.log('Sync endpoint on :4000'));
```

> Replace `let store = null` with a real database for production use. See the full WORKSPACES.md for a versioned example with `ETag` support.

---

## Provider: Team Server

The Team Server is the recommended solution for teams. It adds user accounts, role-based access (owner / editor / viewer), workspace invitation management, and real-time push notifications when a teammate pushes changes.

### How it Works (Team)

1. An administrator deploys the Apilix Team Server (a Node.js Express app).
2. Users register an account on the team server.
3. The workspace owner creates the workspace on the team server and invites teammates by email.
4. Each team member opens **Manage Workspaces → Sync → Team Server**, enters the server URL and their credentials, and clicks **Pull ↓** to join.
5. Pushing and pulling works the same as other providers — with roles enforced server-side.

### Field Reference (Team)

| Field | Required | Notes |
|---|:---:|---|
| Team Server URL | ✅ | Base URL of the team server, e.g. `https://apilix.yourcompany.com` |
| Email | ✅ | User account email |
| Password | ✅ | User account password (stored encrypted) |
| Workspace ID | ✅ | The workspace ID to connect to (provided by the workspace owner) |

### Team Server Administration

The team server exposes an admin REST API. Common operations:

**Create a workspace on the server:**
```bash
curl -X POST https://apilix.yourcompany.com/api/workspaces \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "My API Project", "ownerId": "<user-id>"}'
```

**Invite a teammate:**
```bash
curl -X POST https://apilix.yourcompany.com/api/workspaces/<workspace-id>/members \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"email": "teammate@example.com", "role": "editor"}'
```

**List workspace members:**
```bash
curl https://apilix.yourcompany.com/api/workspaces/<workspace-id>/members \
  -H "Authorization: Bearer <admin-token>"
```

**Remove a member:**
```bash
curl -X DELETE https://apilix.yourcompany.com/api/workspaces/<workspace-id>/members/<user-id> \
  -H "Authorization: Bearer <admin-token>"
```

### Roles

| Role | Push | Pull | Manage members | Delete workspace |
|---|:---:|:---:|:---:|:---:|
| **Owner** | ✅ | ✅ | ✅ | ✅ |
| **Editor** | ✅ | ✅ | ❌ | ❌ |
| **Viewer** | ❌ | ✅ | ❌ | ❌ |

### Self-hosting the Team Server

The Apilix team server is a Node.js Express application included in the `server/` directory.

**Install and start:**
```bash
cd server
npm install
node index.js
# Listening on :3001 by default
```

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port to listen on |
| `DATA_DIR` | `./data` | Directory where workspace data is persisted |
| `JWT_SECRET` | — | Required in production — a strong random secret for JWT signing |
| `ADMIN_TOKEN` | — | Optional static token for admin API calls |

**Production deployment with nginx reverse proxy:**

```nginx
server {
  listen 443 ssl;
  server_name apilix.yourcompany.com;

  location / {
    proxy_pass         http://localhost:3001;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_read_timeout 300s;
  }
}
```

**Running as a systemd service:**

```ini
[Unit]
Description=Apilix Team Server
After=network.target

[Service]
WorkingDirectory=/opt/apilix/server
ExecStart=/usr/bin/node index.js
Restart=on-failure
Environment=PORT=3001
Environment=JWT_SECRET=<your-secret>

[Install]
WantedBy=multi-user.target
```

---

## Remote Data Encryption

Remote data encryption protects the workspace data stored on your sync provider. When enabled, Apilix encrypts the entire workspace JSON with AES-256-GCM before every push and decrypts it transparently after every pull. Even if your S3 bucket, git repository, or HTTP endpoint is compromised, the workspace contents remain unreadable without the passphrase.

> **Desktop (Electron) only.** Remote data encryption requires Electron's `safeStorage` API to protect the passphrase at rest. The toggle is not available in browser mode.

### Enabling remote data encryption

1. Open **Manage Workspaces → Sync** and configure your provider.
2. Toggle **Encrypt remote data** to on.
3. Enter a **Remote passphrase**. This passphrase is required for every push and pull — store it somewhere safe.
4. Click **Save config**.

The passphrase is immediately encrypted with `safeStorage` and stored in `sync-config.json`. It is never written to disk in plaintext.

### How it works

On every **Push ↑** or auto-merge write, the workspace JSON is encrypted with:

- **Algorithm:** AES-256-GCM (authenticated encryption — tampering is detectable)
- **Key derivation:** PBKDF2 — 200 000 iterations, SHA-256, 16-byte random salt
- **Salt storage:** the salt is stored alongside the ciphertext in the remote object

On every **Pull ↓**, Apilix detects the encrypted envelope (a JSON object with `_apilixEncrypted: true`) and decrypts it automatically using the stored passphrase. If the passphrase is missing or incorrect, the pull is blocked with an error.

### Rotating the passphrase

1. Push with the current passphrase to ensure the remote is up to date.
2. Update the **Remote passphrase** field in the Sync tab and click **Save config**.
3. Push again — the workspace is re-encrypted with the new key.

> Any teammates using a sync config export that embedded the old passphrase will need a new export after rotation.

### Encryption scope

| Protected by remote encryption | Not protected |
|---|---|
| Collections, environments, variables | Provider credentials (protected separately by `safeStorage`) |
| Requests, headers, body, scripts | Workspace metadata on the remote (object key / path) |
| Mock routes, cookie jar | |

---

## Sharing Sync Configuration

You can export a workspace's sync configuration to a portable `.json` file and import it on another machine or share it with a teammate. This is the fastest way to onboard someone to the same remote without manually re-entering every field.

### Exporting a sync config

1. Open **Manage Workspaces → Sync**.
2. Configure and save your sync provider settings for the workspace.
3. Scroll to the bottom of the Sync tab and click **Share sync config with a teammate**.
4. Choose whether to **encrypt** the export. Encryption requires a passphrase; the file cannot be imported without it.
5. Optionally configure a [sharing policy](#sharing-policies) (see below).
6. Click **Export**. A file named `apilix-sync-{name}.json` is downloaded.

**What is included:**

| Included | Not included |
|---|---|
| Provider type (`s3`, `minio`, `git`, `http`, `team`) | Workspace data (collections, requests, etc.) |
| All credential fields (token, secret key, URL, etc.) | Snapshot history |
| Workspace ID (used to resolve the remote object) | Sync activity log |
| `readOnly` flag | |
| Sharing policy (when set) | |
| Remote passphrase (when embedded, encrypted) | |

**Encryption:** All credential fields are encrypted with AES-256-GCM using a key derived from the export passphrase (PBKDF2, 200 000 iterations, SHA-256). The provider name, workspace ID, and workspace name remain in plaintext so the recipient can confirm what they are importing before decryption.

> **Encrypted exports include a per-file salt.** The passphrase must match exactly — there is no recovery if it is lost.

### Sharing policies

When exporting a sync config to share with a teammate, you can attach a **sharing policy** to govern how the recipient uses the workspace:

| Policy option | Effect when imported |
|---|---|
| **Force read-only** | The recipient's workspace is permanently set to read-only. Push is disabled — they can only pull. Useful for distributing a workspace snapshot you don't want overwritten. |

Sharing policies are integrity-protected when the export is passphrase-encrypted: an HMAC-SHA-256 over the policy and workspace ID is embedded in the file. On import, Apilix verifies the MAC before applying the policy. If the file was tampered with (e.g. `forceReadOnly` changed to `false`), the import is blocked.

> **HMAC protection only applies to encrypted exports.** Unencrypted exports do not carry an integrity hash — the policy fields are present but are not tamper-evident.

### Embedding the remote passphrase

If you have [remote data encryption](#remote-data-encryption) enabled, teammates who import your sync config also need the remote passphrase to decrypt workspace data after pulling. Rather than sharing the passphrase through a separate channel, you can embed it directly in the encrypted export:

1. Enable **Encrypt this export** and enter an export passphrase.
2. Enable **Embed remote decryption passphrase**.
3. Export the file.

When the recipient imports the file and enters the correct export passphrase, Apilix automatically extracts and stores the remote passphrase so their subsequent pulls decrypt transparently.

> **The export must be encrypted to embed the remote passphrase.** Embedding in an unencrypted file would expose the passphrase in plaintext — Apilix strips it from unencrypted exports.

### Importing a sync config

Sync config files are imported through the same unified **Import** footer used for workspace data files.

1. Open **Manage Workspaces → Workspaces** tab.
2. Click **↑ Import workspace file** (or drag and drop the file).
3. Apilix detects the `apilixSyncExport` sentinel and shows a confirmation card with the provider name and encryption badge.
4. If the export is encrypted, enter the passphrase.
5. Click **Create workspace**.

A new workspace is created with the sync configuration applied. It starts empty — switch to the workspace, open the **Sync** tab, and click **Pull ↓** to load data from the provider.

> **After importing a sync config, the workspace is empty until you Pull.** The export contains credentials, not workspace data. If you need both, export the workspace data separately using the **⬇** button in the workspace row, or just Pull after configuring sync.

### Shared workspace behavior

Workspaces created by importing a share package are marked as **shared workspaces** and display an informational banner in the Sync tab:

> *"This workspace was imported from a share package. Sync settings are managed by the original owner and cannot be changed here."*

Behavior differences in a shared workspace:

| Aspect | Shared workspace |
|---|---|
| Provider settings | Locked — fields cannot be edited |
| Remote data encryption toggle | Locked |
| Push ↑ | Disabled when the export had **Force read-only** set |
| Pull ↓ | Always available |
| Conflict resolution (Apply Merged) | Merged result is applied locally only — remote is not written |
| Save config | Preserves the original sharing policy; does not unlock fields |

---

## Provider Comparison

| Feature | Git | S3 | HTTP Endpoint | Team Server |
|---|:---:|:---:|:---:|:---:|
| Version history on remote | ✅ (git log) | ❌ (unless versioned bucket) | Depends | Depends |
| No third-party cloud required | ✅ (self-host git) | ❌ | ✅ | ✅ |
| Role-based access | ❌ (via github permissions) | ❌ (via IAM) | Custom | ✅ built-in |
| Real-time change notifications | ❌ | ❌ | Custom | ✅ |
| Optimistic conflict locking | ✅ | ❌ | Optional | ✅ |
| Remote data encryption | ✅ | ✅ | ✅ | ✅ |
| Share config with policy | ✅ | ✅ | ✅ | ✅ |
| Setup complexity | Medium | Medium | High | Medium |
| Best for | Developers, open-source teams | Personal backup, simple sharing | Custom infra | Company teams |

---

## Three-Way Merge — Technical Reference

This section documents the internal merge pipeline for developers and advanced users who want to understand exactly how conflicting edits are resolved.

### Pipeline Overview

A pull that detects a newer remote triggers the following sequence:

```
Pull ↓
  1. Fetch remote workspace JSON
  2. Compare remote.timestamp vs syncMetadata.lastSyncedAt
     → remote is newer → enter merge pipeline
  3. Load base snapshot (lastMergeBaseSnapshotId from SnapshotEngine)
  4. diffWorkspace(base, local)   → localDiff
     diffWorkspace(base, remote)  → remoteDiff
  5. mergeWorkspaces(base, local, remote)
     → MergeResult { merged, conflicts[], autoMergedCount }
  6. autoMergedCount > 0 and conflicts === 0 → apply silently
     conflicts > 0                           → open ConflictMergeModal
  7. On Apply:
     - Write merged result to local workspace
     - Update lastMergeBaseSnapshotId
     - If readOnly → stop here (remote is not written)
     - Else → push merged result to remote
```

The **base** is the last snapshot written after a successful push or pull (stored in a ring buffer of up to 50 snapshots per workspace). If no base is available, the pipeline falls back to binary "Use Remote / Keep Local".

### Differ — Request Identity and Change Classification

`workspaceDiffer.ts` produces a `WorkspaceDiff` with change sets for every domain:

```
collections, requests, environments,
globalVariables, collectionVariables, mockRoutes
```

Requests are matched in two passes:

1. **Primary — by stable `id`**: requests that share the same UUID are compared directly. A change is classified as:
   - `added` — present in `changed`, absent in `base`
   - `removed` — present in `base`, absent in `changed`
   - `modified` — same id, different content
   - `moved` — same id, different parent collection/folder path
   - `renamed` — collection-level name change detected via `diffCollectionShapes`

2. **Fallback heuristic** — for requests with mismatched or missing IDs (e.g. after an import from Postman): matches on a normalised key of `method + URL path + name`. If the heuristic finds a pair and their content differs, the result is `modified`. Unmatched items become `added` or `removed`.

### Merge Rules by Domain

#### Requests (`mergeRequestItem`)

For each request modified on both sides, fields are merged independently:

| Field | Auto-merge rule | Conflict type when both sides differ |
|---|---|---|
| **Name** | Only one side renamed → take that rename | `rename-vs-rename` |
| **Body (`raw`)** | Try JSON key-level merge; fall back to line-based LCS | `json-conflict` (JSON) or `json-parse-fallback` / `field-overlap` (text) |
| **Pre-request script** | Only one side changed → take that change; both changed → line-based merge | `field-overlap` |
| **Test script** | Same as pre-request script | `field-overlap` |
| **Headers** | Merged by header key name — non-overlapping key edits always auto-resolve | (no conflict currently produced for headers) |

The merged result starts as a **shallow copy of local** (`merged = { ...local }`). Remote changes are applied only when the local side did not also change that field. This means local is always the default winner for any field not explicitly handled — no data is ever silently discarded from the local side.

**Structural item decisions (`mergeItems`):**

| Scenario | Auto-merge result | Conflict? |
|---|---|---|
| Added only by local | Include | No |
| Added only by remote | Include | No |
| Deleted by both | Omit | No |
| Deleted by local, unmodified by remote | Omit | No |
| Deleted by remote, unmodified by local | Omit | No |
| **Deleted by local, modified by remote** | Include remote version | Yes — `delete-vs-edit` |
| **Deleted by remote, modified by local** | Include local version | Yes — `delete-vs-edit` |
| Present on both sides, both modified | Run `mergeRequestItem` | Yes if fields overlap |

Folders recurse: `mergeItems` is called on `item[]` for every folder node, so the same rules apply at any nesting depth.

#### Body — JSON Structural Merge

When both sides changed `request.body.raw` and all three versions (base, local, remote) parse as valid JSON objects or arrays, Apilix performs a **key-level** three-way merge:

- Keys changed only by local → take local value
- Keys changed only by remote → take remote value  
- Keys changed by both → `json-conflict` conflict node (user resolves per-key)
- Keys added only by local or remote → include
- Keys deleted by one side, unchanged by other → delete

If any version does not parse as JSON, the merge falls back to **line-based LCS diff**. Non-overlapping changed line ranges are auto-resolved. Overlapping ranges produce a `json-parse-fallback` conflict node with hunk-level navigation in the merge modal.

#### Environments

Merged by environment `_id`. Values are merged by variable key name:

| Scenario | Result |
|---|---|
| Key changed only by local | Take local |
| Key changed only by remote | Take remote |
| Key changed by both, same value | Take either (auto) |
| Key changed by both, different values | `field-overlap` conflict on `{envName} — {key}` |
| Key deleted by one side, unchanged by other | Delete |

Name renames follow the same rule as request names.

#### Global Variables and Collection Variables

Merged as flat key→value maps with the same rule as environment values above.

#### Mock Routes

Merged by route `id`, with `delete-vs-edit` logic equivalent to requests. Route content conflicts are raised as `field-overlap` at the route level (no sub-field merge for routes).

#### Fields Outside the Merge Pipeline

| Field | Strategy | Reason |
|---|---|---|
| `cookieJar` | Always keep local | Session-local; cookies are not meaningful across machines |
| `activeEnvironmentId` | Always keep local | Per-session UI state |
| `mockCollections` | Always keep local | Rarely edited concurrently |
| `mockPort` | Take local if changed from base, else take remote | Simple last-writer-wins |

### Snapshot Ring Buffer

After every successful push or pull, Apilix creates a snapshot via `SnapshotEngine.createSnapshot` and stores its ID in `syncMetadata.lastMergeBaseSnapshotId`. Up to **50 snapshots** are kept per workspace (older ones are automatically evicted). The merge pipeline uses this ID to load the base version.

If the snapshot has been evicted (unlikely but possible if a workspace has not synced in a very long time), the base is unavailable and the fallback binary UI is shown.

### Stale-Apply Cycle

```
User opens merge modal (base = version N)
     ↓
Teammate pushes (remote advances to version N+1)
     ↓
User clicks Apply Merged
     ↓
Provider returns 409 STALE_VERSION
     ↓
Apilix fetches version N+1 as new remote
Re-runs diffWorkspace + mergeWorkspaces (base=N, local=user's local, remote=N+1)
Reopens merge modal with fresh conflict set
```

This cycle repeats until the apply succeeds. Because the pipeline always defaults to local values, no local edits are ever lost during a stale-apply recovery.

---

## See Also

- [Workspaces](Workspaces) — workspace contents, local storage layout, and snapshot history
- [Variables & Environments](Variables-and-Environments) — what's included in a sync snapshot
- [Import & Export](Import-and-Export) — moving data without a sync provider
- [Security & Encrypted Data](Security-and-Encrypted-Data) — OS keychain encryption, remote data encryption, sync credential storage
