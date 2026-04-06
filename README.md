# Apilix — Alternative Platform for Instant Live API eXecution

A lightweight, open-source alternative API testing tool — available as a **desktop app** (macOS, Windows, Linux) or as a local web app.

## Features

- **Import** Postman collections (v2.1) and environments
- **Send HTTP requests** (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)
- **Query params, Headers, Body** (raw JSON/text, form-data, url-encoded)
- **Authentication** (Bearer, Basic, API Key)
- **Pre-request & Test scripts** (`pm.*` Postman-compatible API, including `pm.sendRequest()`)
- **Collection Runner** with CSV data-driven testing and multi-iteration support
- **Environment variables** with `{{variable}}` substitution
- **Global variables** — cross-collection variables manageable via the Globals panel and scriptable with `pm.globals.*`
- **Tabbed request editing** — open multiple requests simultaneously, save changes independently
- **Mock Server** — define static or dynamic responses for any endpoint; start a local HTTP server without a real backend
- **Console panel** — view a log of every request and response with resolved variable values; pop out into a live-updating detached window
- **Status bar** — quick access to the console toggle with an unread count badge and last response summary

---

## Desktop App (Electron)

Pre-built installers are available for:

| Platform | File |
|---|---|
| macOS | `Apilix-x.x.x.dmg` |
| Windows | `Apilix Setup x.x.x.exe` |
| Linux | `Apilix-x.x.x.AppImage` |

Download the installer for your platform, install, and launch — no Node.js required.

Data (collections, environments) is stored locally in the app profile:
- **macOS:** `~/Library/Application Support/Apilix/`
- **Windows:** `%APPDATA%\Apilix\`
- **Linux:** `~/.config/Apilix/`

---

## Run from Source

### Prerequisites

- **Node.js** v18+
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
| 3 | **Collection (runtime)** | Per-collection variables set by scripts via `pm.collectionVariables.set()` |
| 4 | **Environment** | Active environment — only enabled rows apply |
| 5 (highest) | **Data row** | CSV column values injected by the Runner for each iteration |

### Environments

Open the **🌍 Envs** tab in the sidebar to create, edit, activate, import, and export environments. Click the environment name in the top bar to switch active environments. Click the 👁 icon to quick-edit variables without leaving the current request.

### Global Variables

Open the **🌐 Globals** sub-tab inside the Envs panel to manage global variables. Globals are shared across all collections and persist across sessions. You can also import/export globals as a Postman-compatible JSON file.

Globals can be read and written from scripts:

```javascript
pm.globals.set("api_version", "v2");
pm.globals.get("api_version");   // → "v2"
pm.globals.unset("api_version");
pm.globals.clear();              // remove all globals
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

Upload the CSV in the Runner panel. Each row becomes one iteration and every column header is available as a `{{variable}}` in your requests and scripts (`pm.iterationData.get("username")`). A preview table shows the first five rows before you run.

Without a CSV you can still set **Iterations** (1–100) to repeat a collection multiple times.

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
pm.test("Status is 200", () => {
  pm.response.to.have.status(200);
});

pm.test("Response has id", () => {
  const json = pm.response.json();
  pm.expect(json.id).to.exist;
});

// Environment variables (active environment)
pm.environment.set("token", pm.response.json().token);
pm.environment.get("baseUrl");
pm.environment.unset("token");

// Global variables (all collections)
pm.globals.set("api_version", "v2");
pm.globals.get("api_version");
pm.globals.unset("api_version");
pm.globals.clear();

// Collection variables (current collection scope)
pm.collectionVariables.set("requestId", Date.now().toString());
pm.collectionVariables.get("requestId");
pm.collectionVariables.unset("requestId");

// Response
pm.response.code         // status code
pm.response.responseTime // ms
pm.response.json()       // parsed body
pm.response.text()       // raw body
pm.response.headers.get("Content-Type")

// Request chaining — make additional HTTP calls from scripts
pm.sendRequest("https://api.example.com/token", (err, res) => {
  if (!err) {
    pm.environment.set("access_token", res.json().access_token);
  }
});

// Full options object (Postman-compatible)
pm.sendRequest({
  url: "https://api.example.com/login",
  method: "POST",
  header: [{ key: "Content-Type", value: "application/json" }],
  body: { mode: "raw", raw: JSON.stringify({ user: "admin", pass: "secret" }) }
}, (err, res) => {
  pm.environment.set("token", res.json().token);
});
```

`pm.sendRequest` accepts a URL string or a Postman-format options object and provides the callback response with `.code`, `.status`, `.headers.get(name)`, `.json()`, and `.text()`.
Works in both **pre-request** and **test** scripts. All chained requests complete before the next request in the collection starts.
