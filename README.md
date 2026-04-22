[![GitHub release](https://img.shields.io/github/v/release/cmik/apilix.svg)](https://github.com/cmik/apilix/releases/latest)

# Apilix — Alternative Platform for Instant Live API eXecution

A lightweight, open-source alternative API testing tool — available as a **desktop app** (macOS, Windows, Linux) or as a local web app.

<img width="1383" height="891" alt="image" src="https://github.com/user-attachments/assets/bb617b66-106f-42fb-bed4-2cb1c60e0d3c" />

## Features

- **Import** Postman collections (v2.1) and environments
- **Browser Capture** — attach to Chrome via CDP, inspect live network traffic, filter/sort requests, review headers/cookies, and import selected requests into a collection
- **Send HTTP requests** (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)
- **Query params, Headers, Body** (raw JSON/text, form-data, url-encoded)
- **Authentication** (Bearer, Basic, API Key)
- **Pre-request & Test scripts** (`apx.*` Postman-compatible API, including `apx.sendRequest()`)
- **Collection Runner** with CSV data-driven testing and multi-iteration support
- **Environment variables** with `{{variable}}` substitution
- **Global variables** — cross-collection variables manageable via the Globals panel and scriptable with `apx.globals.*`
- **Tabbed request editing** — open multiple requests simultaneously, save changes independently
- **Mock Server** — define static or dynamic responses for any endpoint; start a local HTTP server without a real backend
- **Console panel** — view a log of every request and response with resolved variable values; pop out into a live-updating detached window
- **Status bar** — quick access to the console toggle with an unread count badge and last response summary
- **Workspace sync** — back up and share workspaces via Git, S3 / S3-compatible (MinIO, Backblaze B2, Cloudflare R2, etc.), HTTP Endpoint, or a self-hosted Team Server
- **Advanced workspace sync conflicts** — three-way merge UI at request/code level, stale-version recovery, and recent sync activity telemetry

---

## Desktop App (Electron)

Pre-built installers are available for:

| Platform | File |
|---|---|
| macOS | `Apilix-x.x.x.dmg` |
| Windows | `Apilix x.x.x.exe` (portable, no installation required) |
| Linux | `Apilix-x.x.x.AppImage` |

Download the installer for your platform, install, and launch — no Node.js required.

Data (collections, environments) is stored locally in the app profile:
- **macOS:** `~/Library/Application Support/Apilix/`
- **Windows:** `%APPDATA%\Apilix\`
- **Linux:** `~/.config/Apilix/`

---

## Run from Source

### Prerequisites

- **Node.js** v20.19+
- **npm** v9+

### Install dependencies

```bash
npm run setup
```

### Start (web mode)

```bash
npm start
```

- API server: **http://localhost:3001**
- App: **http://localhost:5173**

### Start (Electron desktop mode)

```bash
npm run electron:dev
```

### Run Collections From CI

Use the CLI runner when you want to execute a collection in a pipeline without launching the UI:

```bash
npm run cli -- run \
  ./collection.json \
  -e ./environment.json \
  --reporter both \
  --out-dir ./artifacts
```

The collection file can be passed either as a positional argument (`run ./collection.json`) or with the legacy flag (`run --collection ./collection.json`).

This writes:

- `./artifacts/apilix-run.json`
- `./artifacts/apilix-run.junit.xml`

Common patterns:

```bash
# Default run: terminal summary table (Newman-style)
npm run cli -- run \
  ./collection.json \
  -e ./environment.json

# Print JSON report to stdout
npm run cli -- run \
  ./collection.json \
  -e ./environment.json \
  --reporter json

# Write a single JUnit file for CI test publishing
npm run cli -- run \
  ./collection.json \
  --reporter junit \
  --out ./artifacts/apilix.junit.xml

# Drive one iteration per CSV row
npm run cli -- run \
  ./collection.json \
  -e ./environment.json \
  --csv ./data.csv \
  --reporter both \
  --out-dir ./artifacts

# Backward-compatible legacy syntax
npm run cli -- run \
  --collection ./collection.json \
  --environment ./environment.json \
  --reporter json

# Disable ANSI colors for plain CI logs
npm run cli -- run \
  ./collection.json \
  --no-color
```

Useful flags:

- `--csv ./data.csv` to run one iteration per CSV row
- `--iterations 5` to repeat a run without a CSV file
- `--execute-child-requests` to allow `apx.sendRequest()` inside scripts
- `--no-conditional-execution` to ignore `setNextRequest()` flow overrides
- `--timeout 10000` to override the default request timeout
- `--ssl-verification` to enforce TLS verification in CI
- `--no-follow-redirects` to surface redirect responses instead of following them automatically
- `--no-color` to output plain text without ANSI color sequences

Exit codes:

- `0` successful run with no failed assertions or request errors
- `1` failed assertions, request errors, or runner flow errors
- `2` invalid CLI usage or unreadable/invalid input files

Notes:

- By default, the CLI prints a per-request summary table to the terminal.
- `json` and `junit` reporters write to standard output unless you pass `--out` or `--out-dir`.
- `--reporter both` always requires `--out-dir`.
- Malformed CSV input fails fast with exit code `2` instead of silently falling back to iteration-only execution.

---

## Build Standalone CLI Binaries

Build standalone `apilix` binaries for macOS, Linux, and Windows using `pkg`:

```bash
npm run cli:build:binaries
```

Output directory:

- `dist/cli/`

---

## Build Desktop Installers

```bash
# All platforms
./build-all.sh

# Or individually
npm run dist:mac    # → dist/Apilix-x.x.x.dmg
npm run dist:win    # → dist/Apilix Setup x.x.x.exe
```

> Cross-platform builds (e.g. `.exe` on macOS) may require Wine or Docker for some targets.

---

## Helper Scripts

### macOS / Linux

```bash
./install.sh   # install all dependencies
./start.sh     # start server + client
./stop.sh      # stop both services
./restart.sh   # restart both services
./status.sh    # check health
```

### Windows (PowerShell)

```powershell
.\install.ps1
.\start.ps1
.\stop.ps1
.\restart.ps1
.\status.ps1
```

> If PowerShell blocks unsigned scripts, run once:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

---

## Mock Server

The **🎭 Mock** tab lets you spin up a local HTTP server that returns custom responses without a real backend.

### Setup

1. Open the **Mock** tab in the sidebar.
2. Set the port (default `3002`) and click **Start**.
3. Click **+ Add Route** to define a mock endpoint.

### Route options

| Field | Description |
|---|---|
| Method | HTTP verb or `*` (any) |
| Path | URL path, supports `:param` segments (e.g. `/api/users/:id`) |
| Status Code | HTTP status to return |
| Response Headers | Custom headers (e.g. `Content-Type`) |
| Response Body | Static text, JSON, or a template with substitutions |
| Delay (ms) | Artificial delay before the response is sent |

### Dynamic substitution

Use template placeholders in the response body or header values:

```
{{param.id}}       → path segment (:id)
{{query.page}}     → query string (?page=2)
{{body.username}}  → JSON request body field
```

Example response body:

```json
{
  "id": "{{param.id}}",
  "page": "{{query.page}}",
  "echo": "{{body.message}}"
}
```

Routes are matched in order — the first enabled route whose method and path match wins. Toggle individual routes on/off without deleting them. All routes and the selected port are persisted across sessions.

### Notes

- The mock server runs inside the Apilix backend process, so the Apilix server must be running
- Routes are **hot-synced** to the running server as you add, edit, or disable them — no restart needed
- CORS headers are added automatically, so browser-based frontends can call the mock server directly

---

## Browser Capture (Chrome CDP)

The **📡 Capture** tab lets you attach Apilix to a Chrome instance exposing the Chrome DevTools Protocol (CDP) and inspect live browser network traffic.

### Connecting

In the **Electron desktop app**:

1. Open the **📡 Capture** tab in the sidebar.
2. Leave the default Chrome path or point it at a custom Chrome/Chromium executable.
3. Keep the default debug port `9222` unless you launched Chrome on a different port.
4. Click **Launch Chrome** to start Chrome with remote debugging enabled, then connect automatically.

In **web mode** or if Chrome is already running:

1. Start Chrome manually with remote debugging enabled:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

1. Open the **📡 Capture** tab.
2. Set the matching port and click **Connect**.

### What you can inspect

Each captured request shows:

- Method, domain, URL path, resource classification, status, duration, and size
- Full request headers and response headers
- Request body and response body (text responses only; large bodies may be truncated)
- Request cookies and parsed response `Set-Cookie` attributes

### Filtering and sorting

Use the filter bar to narrow captured traffic by:

- URL text search
- Domain
- HTTP method
- Status group (`2xx`, `3xx`, `4xx`, `5xx`, `failed`, `pending`)
- Chrome resource type (`XHR`, `Fetch`, `Document`, `Script`, `Stylesheet`, `Image`, etc.)

The table headers are sortable for method, domain, URL, type, status, duration, and size. Capture filters and sorting are preserved when switching away from the panel and back during the same session.

### Importing captured requests

1. Select one or more captured rows with the checkbox column.
2. Click **Import to new collection** to create a new collection from the selected requests.
3. Or choose **Import to existing…** to append them to an existing collection.

### Capture Notes

- **Clear** removes the current capture session without affecting collections already imported.
- The Electron-only **Launch Chrome** button is a convenience wrapper around Chrome's `--remote-debugging-port` startup flag.
- Binary response bodies are not fully displayed in the panel; they are shown as binary placeholders where applicable.

---

## Importing from Postman

1. In Postman, export your collection as **Collection v2.1**
2. Export any environments you use
3. In Apilix, click **Import** in the sidebar and select the JSON files

---

## Variables

Apilix resolves `{{variable}}` placeholders in URLs, headers, body, and auth fields. Variables are merged from multiple scopes in order of increasing priority — a higher-priority scope wins when the same key exists in multiple scopes.

| Priority | Scope | Description |
|:---:|---|---|
| 1 (lowest) | **Collection definition** | Variables declared in the collection JSON `variable[]` array |
| 2 | **Global** | Cross-collection variables managed in the 🌐 Globals panel |
| 3 | **Collection (runtime)** | Per-collection variables set by scripts via `apx.collectionVariables.set()` |
| 4 | **Environment** | Active environment — only enabled rows apply |
| 5 (highest) | **Data row** | CSV column values injected by the Runner for each iteration |

### Environments

Open the **🌍 Envs** tab in the sidebar to create, edit, activate, import, and export environments. Click the environment name in the top bar to switch active environments. Click the 👁 icon to quick-edit variables without leaving the current request.

### Global Variables

Open the **🌐 Globals** sub-tab inside the Envs panel to manage global variables. Globals are shared across all collections and persist across sessions. You can also import/export globals as a Postman-compatible JSON file.

Globals can be read and written from scripts:

```javascript
apx.globals.set("api_version", "v2");
apx.globals.get("api_version");   // → "v2"
apx.globals.unset("api_version");
apx.globals.clear();              // remove all globals
```

Changes made in scripts are propagated back to the store after the request completes and carry forward to subsequent requests in the Runner.

---

## Collection Runner with CSV

Create a CSV file where each column is a variable name:

```csv
username,password,expectedStatus
admin,secret,200
guest,wrong,401
```

Upload the CSV in the Runner panel. Each row becomes one iteration and every column header is available as a `{{variable}}` in your requests and scripts (`apx.iterationData.get("username")`). A preview table shows the first five rows before you run.

Without a CSV you can still set **Iterations** (1–100) to repeat a collection multiple times.

### Runner Streaming Memory Behavior

Runner executions started through the server streaming endpoint (`/api/run`) are processed in low-memory mode:

- The server streams per-request events as they happen.
- The server does **not** retain full per-request payload history in memory.
- The server does **not** retain per-iteration history in memory.

This keeps memory usage stable for large CSV runs and large response bodies.

---

## Tabs

Click any request in the sidebar to open it in a tab. Unsaved changes are indicated by an orange dot on the tab. Use the **Save** button (or the save icon in the tab) to write changes back to the collection. Tabs for a deleted collection are automatically closed.

---

## Console

The **Console** panel (toggle via the status bar at the bottom) logs every request and response with:

- Resolved URL (variables already substituted)
- Request headers and body
- Response status, duration, and body
- Expandable rows for full detail

Click **New window** to pop the console out into a separate browser tab that live-updates as new requests come in.

---

## Test Scripts (`pm` API)

Apilix supports a subset of the Postman `pm` scripting API:

```javascript
// Tests
apx.test("Status is 200", () => {
  apx.response.to.have.status(200);
});

apx.test("Response has id", () => {
  const json = apx.response.json();
  apx.expect(json.id).to.exist;
});

// Environment variables (active environment)
apx.environment.set("token", apx.response.json().token);
apx.environment.get("baseUrl");
apx.environment.unset("token");

// Global variables (all collections)
apx.globals.set("api_version", "v2");
apx.globals.get("api_version");
apx.globals.unset("api_version");
apx.globals.clear();

// Collection variables (current collection scope)
apx.collectionVariables.set("requestId", Date.now().toString());
apx.collectionVariables.get("requestId");
apx.collectionVariables.unset("requestId");

// Response
apx.response.code         // status code
apx.response.responseTime // ms
apx.response.json()       // parsed body
apx.response.text()       // raw body
apx.response.xml()        // parsed DOM document (for XML/SOAP responses)
apx.response.xmlPath("//token")    // first XPath match text, or null
apx.response.xmlPathAll("//item")  // array of all XPath match texts
apx.response.headers.get("Content-Type")

// xpath global — full XPath library
const doc   = apx.response.xml();
const token = xpath.value("//token", doc);
apx.environment.set("authToken", token);

// Request chaining — make additional HTTP calls from scripts
apx.sendRequest("https://api.example.com/token", (err, res) => {
  if (!err) {
    apx.environment.set("access_token", res.json().access_token);
  }
});

// Full options object (Postman-compatible)
apx.sendRequest({
  url: "https://api.example.com/login",
  method: "POST",
  header: [{ key: "Content-Type", value: "application/json" }],
  body: { mode: "raw", raw: JSON.stringify({ user: "admin", pass: "secret" }) }
}, (err, res) => {
  apx.environment.set("token", res.json().token);
});
```

`apx.sendRequest` accepts a URL string or a Postman-format options object and provides the callback response with `.code`, `.status`, `.headers.get(name)`, `.json()`, and `.text()`.
Works in both **pre-request** and **test** scripts. All chained requests complete before the next request in the collection starts.

---

## Workspaces

Workspaces let you keep separate sets of collections, environments, and variables. Switch between them from the sidebar — each workspace is stored independently on disk.

Open **Manage Workspaces** (gear icon next to the workspace name) to:

- Create, rename, duplicate, or delete workspaces
- Assign a colour to each workspace for quick identification
- Sync a workspace to a remote provider (Git, S3 / S3-compatible, HTTP, or a Team server)
- Browse and restore automatic snapshots (History tab)

### Git Sync

The **Sync** tab lets you back up and share a workspace via a Git repository.

#### Prerequisites

- Git must be installed on the machine running the Apilix server (`git --version` to verify)
- A remote repository (GitHub, GitLab, Gitea, etc.) — **create it empty** (no initial README) for a clean first push

#### Setting up

1. Create an **empty** repository on your Git host.
2. Generate a **Personal Access Token** with repo write access:
   - GitHub: Settings → Developer settings → Personal access tokens → `repo` scope
   - GitLab: Settings → Access Tokens → `read_repository` + `write_repository`
3. Open **Manage Workspaces → Sync**, select **Git Repository**, and fill in the fields:

| Field | Required | Notes |
|---|:---:|---|
| Remote URL | ✅ | `https://github.com/user/repo.git` |
| Branch | — | Defaults to `main` if left blank |
| Username | — | Required only for HTTPS auth (not SSH) |
| Token / Password | — | Required together with Username for private repos |
| Author Name | ⚠ | Used for git commits — needed if no global `git config user.name` |
| Author Email | ⚠ | Used for git commits — needed if no global `git config user.email` |

4. Click **Push ↑** — Apilix initialises a local git repo and pushes `workspace.json` to the remote.
5. On any other machine, fill in the same config and click **Pull ↓** (or **Import once ↓** if you don't want to save the config).

#### Buttons

| Button | Behaviour |
|---|---|
| **Push ↑** | Saves config, commits the current workspace, and pushes to the remote |
| **Pull ↓** | Saves config, fetches the remote, and replaces the local workspace |
| **Save config** | Persists the connection details without pushing or pulling |
| **Import once ↓** | Pulls once without saving the config — useful for a one-time clone |

> **Tip:** If the remote already has commits (not empty), click **Import once ↓** before pushing to avoid a divergent-branches error.

### Amazon S3 / S3-Compatible Sync

Stores the workspace as a JSON object in an S3-compatible bucket using presigned URLs generated inside the Electron main process — AWS credentials never reach the renderer. Both Amazon S3 and self-hosted S3-compatible services (MinIO, Backblaze B2, Cloudflare R2, DigitalOcean Spaces) are supported.

> **Electron only** — S3 sync is not available in browser/web mode.

#### Setting up (AWS S3)

1. Create an S3 bucket (or reuse an existing one).
2. Create an IAM user or role with the following permissions on the bucket:
   ```
   s3:GetObject
   s3:PutObject
   s3:HeadObject
   ```
3. Generate an **Access Key ID** and **Secret Access Key** for that user.
4. Open **Manage Workspaces → Sync**, select **S3 Storage**, and fill in the fields:

| Field | Required | Notes |
|---|:---:|---|
| Endpoint URL | — | Leave blank for AWS S3. Set to server URL for S3-compatible services, e.g. `http://localhost:9000` |
| Bucket | ✅ | S3 bucket name (e.g. `my-apilix-bucket`) |
| Region | — | AWS region (e.g. `us-east-1`). Optional for S3-compatible services |
| Prefix | — | Key prefix for the object, defaults to `apilix/` |
| Access Key ID | ✅ | AWS credential — stored encrypted on disk |
| Secret Access Key | ✅ | AWS credential — stored encrypted on disk |

5. Click **Test connection** to verify credentials, then **Push ↑** to upload. The workspace is stored at `{prefix}{workspaceId}.json` in the bucket.

#### Setting up (MinIO / S3-compatible)

1. Start MinIO or your S3-compatible service.
2. Create a bucket and generate an access key + secret.
3. Open **Manage Workspaces → Sync**, select **S3 Storage**.
4. Set **Endpoint URL** to your server URL (e.g. `http://localhost:9000`), fill in Bucket, Access Key ID, and Secret Access Key.
5. Click **Test connection** to verify, then **Save config** and **Push ↑**.

---

### HTTP Endpoint Sync

Pushes and pulls workspace JSON to/from any HTTP endpoint that accepts a JSON body — useful for a self-hosted sync service or a serverless function.

#### Expected API contract

| Operation | Method | Body / Response |
|---|---|---|
| Push | `PUT {endpoint}` | Body: `{ data, lastModified }` → any 2xx |
| Pull | `GET {endpoint}` | Response: `{ data: WorkspaceData }` or 404 |
| Timestamp | `HEAD {endpoint}` | `Last-Modified` or `X-Last-Modified` header |

#### Setting up

1. Deploy (or identify) an HTTP endpoint that implements the contract above.
2. Open **Manage Workspaces → Sync**, select **HTTP Endpoint**, and fill in the fields:

| Field | Required | Notes |
|---|:---:|---|
| Endpoint URL | ✅ | Full URL, e.g. `https://api.example.com/workspaces/prod` |
| Bearer Token | — | Sent as `Authorization: Bearer <token>` if provided |

3. Click **Push ↑** to upload or **Pull ↓** to download.

---

### Team Server Sync

Syncs with a self-hosted **Apilix team server** that provides role-based access control (RBAC) for shared workspaces. Deploy the standalone `apilix-team-server` project and follow its README for setup instructions.

#### Connecting a workspace

1. Obtain a JWT token from the team server (login endpoint or admin console).
2. Note the **Server Workspace ID** assigned to your workspace on the server.
3. Open **Manage Workspaces → Sync**, select **Team Server**, and fill in the fields:

| Field | Required | Notes |
|---|:---:|---|
| Server URL | ✅ | Base URL of the team server, e.g. `https://apilix.yourcompany.com` |
| Server Workspace ID | ✅ | The workspace ID as registered on the server (for example, a server-generated hex ID) |
| JWT Token | ✅ | Session token — RBAC is enforced server-side |

4. Use **Test connection** to verify before pushing.
5. Click **Push ↑** to upload or **Pull ↓** to sync the latest version from the server.

---

## Team Management

The Apilix team server is a self-hosted Express service available as the standalone `apilix-team-server` project. It lets multiple users share workspaces with role-based access control and runs as a separate process from the main API server.

### Roles

| Role | Pull data | Push data | Manage members | Delete workspace |
|---|:---:|:---:|:---:|:---:|
| **viewer** | ✅ | ✗ | ✗ | ✗ |
| **editor** | ✅ | ✅ | ✗ | ✗ |
| **owner** | ✅ | ✅ | ✅ | ✅ |

The workspace creator is automatically the **owner**. The bootstrap admin (see below) is also an owner globally.

### Starting the server

See the `apilix-team-server` project for full setup instructions.

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `TEAM_PORT` | `3003` | Port the team server listens on |
| `TEAM_DATA_DIR` | `~/.apilix-team` | Directory where user and workspace data is stored |
| `ADMIN_EMAIL` | — | Email for the bootstrap admin user (created on first run) |
| `ADMIN_PASSWORD` | — | Password for the bootstrap admin user |

Example:

```bash
TEAM_PORT=3003 \
ADMIN_EMAIL=admin@yourcompany.com \
ADMIN_PASSWORD=changeme \
node index.js
```

The admin credentials are only used on **first run** to create the admin user. The password is hashed (bcrypt when available, SHA-512 otherwise) and the plaintext is never stored.

Data is stored as JSON files under `TEAM_DATA_DIR/team/`:

```
~/.apilix-team/team/
  users.json          ← user accounts
  workspaces.json     ← workspace metadata and member lists
  .secret             ← JWT signing secret (auto-generated, mode 600)
  data/
    {workspaceId}.json  ← workspace data blobs
```

### API reference

All routes except `/auth/login` and `/health` require a `Authorization: Bearer <token>` header.

#### Authentication

```
POST /auth/login
Body: { "email": "...", "password": "..." }
Response: { "token": "eyJ...", "user": { "id", "name", "email", "role" } }
```

Tokens are valid for **30 days**.

#### Workspaces

| Method | Path | Min role | Description |
|---|---|---|---|
| `GET` | `/workspaces` | any member | List workspaces the caller belongs to |
| `POST` | `/workspaces` | authenticated | Create a new workspace |
| `GET` | `/workspaces/:id` | viewer | Get workspace metadata |
| `DELETE` | `/workspaces/:id` | owner | Delete a workspace and its data |
| `PUT` | `/workspaces/:id/members` | owner | Add or update a member |
| `DELETE` | `/workspaces/:id/members/:uid` | owner | Remove a member |
| `GET` | `/workspaces/:id/data` | viewer | Pull workspace data |
| `PUT` | `/workspaces/:id/data` | editor | Push workspace data |
| `HEAD` | `/workspaces/:id/data` | viewer | Get `X-Last-Modified` timestamp |
| `GET` | `/health` | — | Health check |

#### Creating a workspace (curl example)

```bash
# 1. Log in and capture the token
TOKEN=$(curl -s -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourcompany.com","password":"changeme"}' \
  | jq -r .token)

# 2. Create a workspace
curl -X POST http://localhost:3003/workspaces \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Team Workspace"}'
# → { "workspace": { "id": "a1b2c3d4", "name": "My Team Workspace", ... } }

# 3. Add a member (replace USER_ID and role as needed)
curl -X PUT http://localhost:3003/workspaces/a1b2c3d4/members \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<USER_ID>","role":"editor"}'
```

#### Connecting Apilix to the team server

1. Start the team server and note its URL (e.g. `http://localhost:3003` or your public hostname).
2. Each team member logs in to get their JWT token (via the `/auth/login` endpoint above or a future login UI).
3. In **Manage Workspaces → Sync**, select **Team Server** and enter:
   - **Server URL** — base URL of the team server
   - **Server Workspace ID** — the `id` returned when the workspace was created (`a1b2c3d4` in the example above)
   - **JWT Token** — the member's personal token
4. Click **Test connection** to verify, then **Push ↑** / **Pull ↓** to sync.
