# Browser Capture

Browser Capture intercepts live network traffic from Google Chrome by connecting to its built-in [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/) remote debugging interface. Every HTTP/HTTPS request and response Chrome makes is streamed in real-time to Apilix, where you can inspect headers, bodies, cookies, timing, and then import selected requests directly into your collections.

> **Security note:** The CDP endpoints in Apilix are restricted to loopback addresses (`127.0.0.1` / `::1`) only. They cannot be reached from external network interfaces.

> **Session note:** Captured traffic is held in memory for the current session only. It is not saved to your workspace and is lost when you reload the app or switch workspaces.

---

## Table of Contents

- [Browser Capture](#browser-capture)
  - [Table of Contents](#table-of-contents)
  - [How It Works](#how-it-works)
  - [Prerequisites](#prerequisites)
  - [Connecting — Desktop (Electron)](#connecting--desktop-electron)
    - [Steps](#steps)
  - [Connecting — Web Mode](#connecting--web-mode)
    - [Steps](#steps-1)
  - [The Traffic Table](#the-traffic-table)
  - [Filtering Traffic](#filtering-traffic)
  - [Sorting Columns](#sorting-columns)
  - [Detail Pane](#detail-pane)
    - [Request tab](#request-tab)
    - [Response tab](#response-tab)
    - [Cookies tab](#cookies-tab)
  - [Selecting Entries](#selecting-entries)
  - [Importing into Collections](#importing-into-collections)
    - [Import to new collection](#import-to-new-collection)
    - [Import to existing collection](#import-to-existing-collection)
    - [What gets imported](#what-gets-imported)
  - [Common Workflows](#common-workflows)
    - [Capture and replay a login flow](#capture-and-replay-a-login-flow)
    - [Build a collection from an existing web app](#build-a-collection-from-an-existing-web-app)
    - [Investigate a slow endpoint](#investigate-a-slow-endpoint)
    - [Debug cookie issues](#debug-cookie-issues)
    - [Find large responses causing performance issues](#find-large-responses-causing-performance-issues)
  - [Limitations](#limitations)

---

## How It Works

```
Chrome (--remote-debugging-port=9222)
        │
        │  HTTP GET /json  (list page targets)
        ▼
Apilix Server (localhost)
        │
        │  WebSocket (CDP)
        ▼
Network.requestWillBeSent / Network.responseReceived
        │
        │  Server-Sent Events (SSE)
        ▼
Apilix Browser Capture Panel
```

1. Apilix server queries `http://127.0.0.1:<port>/json` to list Chrome's open page targets.
2. It opens a WebSocket to the first page target's `webSocketDebuggerUrl`.
3. It enables the CDP `Network` domain, which causes Chrome to emit network events.
4. Each event is broadcast to the Apilix UI over a Server-Sent Events (SSE) stream (`/cdp/stream`).
5. The panel updates in real-time as requests flow through Chrome.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Google Chrome | Any recent version. Chromium also works. |
| Remote debugging port | Chrome must be started with `--remote-debugging-port=9222` (or your chosen port) |
| Loopback access | Both Apilix server and Chrome must run on the same machine |

**Chrome command to enable remote debugging manually:**

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-profile

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir=C:\temp\chrome-debug

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

> Using a separate `--user-data-dir` keeps the debug profile isolated from your normal Chrome profile.

---

## Connecting — Desktop (Electron)

In the Electron desktop app, Apilix can launch Chrome for you automatically.

![Browser Capture toolbar — Electron mode](images/browser-capture-toolbar-electron.png)

### Steps

1. Open the **Browser Capture** panel from the Activity Bar (📡 icon).
2. In the **Chrome executable path** field, confirm or update the path to your Chrome binary. Apilix pre-fills the OS-appropriate default:
   - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
   - Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`
   - Linux: `/usr/bin/google-chrome`
3. Set the **Port** (default `9222`). Change this if port 9222 is already in use.
4. Click **🚀 Launch Chrome** — Apilix launches Chrome with `--remote-debugging-port` and automatically connects after a short delay.
   - Alternatively, if Chrome is already running with the correct port, click **Connect** instead.
5. The toolbar shows a pulsing green **Capturing** indicator when the connection is live.
6. Browse in Chrome — requests appear in the table in real-time.
7. Click **⏹ Disconnect** to stop capturing (this also terminates the Chrome process that was launched by Apilix).

---

## Connecting — Web Mode

When running Apilix in a browser (not Electron), you must start Chrome manually with remote debugging enabled, then connect Apilix to it.

![Browser Capture toolbar — web mode](images/browser-capture-toolbar-web.png)

### Steps

1. Start Chrome with `--remote-debugging-port=9222` (see [Prerequisites](#prerequisites)).
2. Open the **Browser Capture** panel.
3. Set the **Port** to match the port you used when starting Chrome.
4. Click **Connect**.
5. If successful, the **Capturing** indicator appears. If an error message appears (e.g. "No debuggable page target found"), make sure at least one tab is open in Chrome.

> **Tip:** The "Launch Chrome" button is hidden in web mode because web-based Apilix cannot spawn processes on your machine.

---

## The Traffic Table

Once capturing is active, every network request Chrome makes appears as a row in the table.

![Browser Capture traffic table](images/browser-capture-table.png)

| Column | Description |
|---|---|
| **☐** | Checkbox — select this entry for import |
| **Method** | HTTP verb, colour-coded (GET=green, POST=orange, PUT=blue, PATCH=purple, DELETE=red) |
| **Domain** | Hostname of the request target |
| **URL** | Path + query string (hover for the full URL) |
| **Type** | Resource type reported by Chrome (`XHR`, `Fetch`, `Document`, `Script`, `Stylesheet`, `Image`, etc.) |
| **Status** | HTTP status code, colour-coded (2xx=green, 3xx=yellow, 4xx=orange, 5xx=red). Shows a spinner for in-flight requests, `Err` for failed ones. |
| **Duration** | Total request round-trip time |
| **Size** | Response body size |

The entry count in the filter bar updates as you type — e.g. `47 entries`.

---

## Filtering Traffic

The filter bar sits below the toolbar and applies all active filters simultaneously.

![Browser Capture filter bar](images/browser-capture-filters.png)

| Control | What it filters |
|---|---|
| **Search URL** | Substring match on the full URL (case-insensitive) |
| **Filter domain** | Substring match on the hostname |
| **Method dropdown** | Exact HTTP method match; populated dynamically from captured traffic |
| **Status dropdown** | `ALL` / `2xx` / `3xx` / `4xx` / `5xx` / `failed` / `pending` |
| **Resource type dropdown** | `All resources` or a specific type present in current traffic |

All filters are additive (AND logic). To reset a filter, clear the text field or select `ALL` in the dropdown.

Use **Clear** in the toolbar to erase all captured entries and reset the table.

---

## Sorting Columns

Click any column header to sort by that column. Click again to reverse direction. An arrow indicator (↑ / ↓) shows the active sort.

| Default sort | Behaviour |
|---|---|
| No column clicked | Newest entries at the top (descending timestamp) |
| Numeric columns (`Status`, `Duration`, `Size`) | Ascending on first click; ties broken by timestamp descending |
| Text columns (`Method`, `Domain`, `URL`, `Type`) | Ascending alphabetical on first click |

---

## Detail Pane

Click any row to open the **Detail Pane** alongside the table (table shrinks to 50% width, pane takes the other 50%).

![Browser Capture detail pane](images/browser-capture-detail.png)

The detail pane has three tabs:

### Request tab

- **Meta grid**: Method, Domain, Type, State
- **URL**: full raw URL
- **Cookies**: request cookies (name/value table)
- **Headers**: all request headers (`:pseudo-headers` and `cookie` are excluded for clarity)
- **Body**: raw request body, if any

### Response tab

- **Meta grid**: Status, Domain, Type, Duration, Size, MIME type
- **Status badge**: colour-coded status code + status text + MIME
- **Set-Cookie**: response cookies table
- **Headers**: all response headers
- **Body**: raw response body preview (capped at 50 000 characters; appends `[truncated]` if larger)
- **Error text**: displayed in red for failed requests

### Cookies tab

Full cookie cards for both request and response cookies, showing:
- Cookie name and value
- Flags: `Secure`, `HttpOnly`, `Partitioned`, `SameSite=<value>`
- Attributes grid: Domain, Path, Expires, Max-Age
- Full attribute list (any non-standard attributes)
- Raw `Set-Cookie` header string

Click elsewhere in the table (or click the selected row again) to close the detail pane.

---

## Selecting Entries

Use the checkboxes to mark entries for import.

| Action | How |
|---|---|
| Select one entry | Click its checkbox |
| Select all visible entries | Click the header checkbox |
| Deselect all | Uncheck the header checkbox |
| Select across pages | Filters apply first — select-all only covers the filtered set |

The selection state is independent of any active filters: unchecking the header checkbox deselects only the currently visible (filtered) rows.

When at least one entry is selected, the **Import bar** appears at the bottom of the panel.

---

## Importing into Collections

The import bar appears automatically when one or more entries are checked.

![Browser Capture import bar](images/browser-capture-import-bar.png)

```
3 selected  [Import to new collection]  [Import to existing… ▼]
```

### Import to new collection

Creates a new collection named `Capture HH:MM:SS` (current time) containing all selected entries as individual requests. The new collection appears immediately in your sidebar.

### Import to existing collection

Select a collection from the dropdown to append the selected entries to it. The collection is updated in-place.

### What gets imported

Each captured entry becomes a `CollectionItem` with:

| Field | Converted from |
|---|---|
| **Name** | `METHOD /path?query` |
| **Method** | HTTP verb (normalized to uppercase) |
| **URL** | Parsed into protocol, host, port, path segments, and query params |
| **Headers** | All request headers (pseudo-headers like `:authority` and `cookie` are removed) |
| **Body — JSON** | Raw body with `language: json` when `Content-Type` is `application/json` |
| **Body — Form** | Decoded key/value pairs when `Content-Type` is `application/x-www-form-urlencoded` |
| **Body — Other** | Raw body text |

After import, the selected entries are automatically deselected.

---

## Common Workflows

### Capture and replay a login flow

1. Launch Chrome via Browser Capture.
2. Log in to your target application in Chrome.
3. In the filter bar, set **Method** → `POST` and **Status** → `2xx`.
4. Tick the authentication requests (e.g. `/api/auth/login`, `/oauth/token`).
5. Click **Import to new collection** → name it "Auth Flow".
6. Add environment variables for credentials and swap hardcoded values for `{{username}}` / `{{password}}`.
7. Run via the Collection Runner.

### Build a collection from an existing web app

1. Connect to Chrome.
2. Navigate the whole app — click through every feature you want to test.
3. Use the **Search URL** filter to focus on your API's domain (e.g. `api.example.com`).
4. Filter **Type** → `XHR` / `Fetch` to exclude static assets.
5. Select all (`Select All` header checkbox).
6. **Import to new collection**.

### Investigate a slow endpoint

1. Capture traffic while reproducing the slow scenario.
2. Click the **Duration** header to sort by slowest first.
3. Click the slow row → **Response** tab to inspect headers (look for `X-Cache`, `X-Response-Time`, etc.) and body size.

### Debug cookie issues

1. Capture the relevant request.
2. Open the **Cookies** tab in the detail pane.
3. Check `HttpOnly`, `SameSite`, `Secure` flags, and the `Expires` / `Max-Age` values.

### Find large responses causing performance issues

1. Sort by **Size** (descending).
2. Import the largest endpoints.
3. Add pre-request scripts that log `apx.request.url` to track them in future runs.

---

## Limitations

| Limitation | Detail |
|---|---|
| **Not persisted** | All captured entries live in memory only. Reloading the app, switching workspaces, or closing the tab discards everything. |
| **Response body cap** | Response bodies larger than **1 MB** are truncated on ingestion. The body field will contain `[truncated — body exceeded 1 MB]`. |
| **Binary responses** | Binary response bodies (images, fonts, etc.) cannot be displayed as text. The body field shows `[binary data]`. |
| **Detail pane display cap** | Even for bodies within 1 MB, the detail pane renders at most **50 000 characters** for performance. |
| **Page targets only** | CDP captures the first `page` target found in Chrome. Requests made by service workers, web workers, or separate browser targets (e.g. child windows) may not appear. |
| **Localhost only** | The CDP endpoint is accessible on `127.0.0.1` / `::1` only. Remote CDP connections are blocked. |
| **Single Chrome instance** | Only one CDP connection is active at a time. Connecting again disconnects the previous session. |
