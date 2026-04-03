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
- **Tabbed request editing** — open multiple requests simultaneously, save changes independently
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

## Importing from Postman

1. In Postman, export your collection as **Collection v2.1**
2. Export any environments you use
3. In Apilix, click **Import** in the sidebar and select the JSON files

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

// Variables
pm.environment.set("token", pm.response.json().token);
pm.environment.get("baseUrl");

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
