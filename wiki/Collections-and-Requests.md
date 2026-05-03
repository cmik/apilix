# Collections & Requests

Collections are the primary way to organise your API work in Apilix. A collection is a named container that holds folders and requests, along with shared auth, variables, and scripts that apply to everything inside it.

---

## Table of Contents

1. [Collections](#collections)
   - [Creating a Collection](#creating-a-collection)
   - [Collection Settings](#collection-settings)
   - [Folders](#folders)
2. [Requests](#requests)
   - [Creating a Request](#creating-a-request)
   - [HTTP Methods](#http-methods)
   - [URL Bar](#url-bar)
   - [Query Parameters](#query-parameters)
   - [Request Headers](#request-headers)
   - [Request Body](#request-body)
   - [Authentication](#authentication)
   - [Pre-request & Test Scripts](#pre-request--test-scripts)
   - [Request Description](#request-description)
3. [Sending a Request](#sending-a-request)
4. [Response Viewer](#response-viewer)
   - [Body Tab](#body-tab)
   - [Headers Tab](#headers-tab)
   - [Cookies Tab](#cookies-tab)
   - [Timeline Tab](#timeline-tab)
   - [TLS Certificate Tab](#tls-certificate-tab)
   - [Redirect Chain Tab](#redirect-chain-tab)
5. [Response Search](#response-search)
6. [Body Editor Find & Replace](#body-editor-find--replace)
7. [JSONPath / JMESPath Tester](#jsonpath--jmespath-tester)
8. [Tabbed Editing](#tabbed-editing)
9. [Collection Tree Actions](#collection-tree-actions)
10. [Cookie Manager](#cookie-manager)
11. [Console Panel](#console-panel)

---

## Collections

A **collection** is the top-level grouping unit. It can contain:

- **Requests** — individual HTTP calls
- **Folders** — nested groups of requests, each with their own optional auth, variables, and scripts
- **Collection-level auth** — default auth inherited by all requests that use `inherit`
- **Collection variables** — key/value pairs scoped to this collection
- **Pre-request & test scripts** — scripts that run before/after every request in the collection

Collections are stored inside the active workspace. Switching workspaces shows a different set of collections.

### Creating a Collection

1. In the **Sidebar**, click the **+** button at the top of the collection tree, or right-click anywhere in the tree and select **New Collection**.
2. Type a name and press `Enter`.

![Creating a new collection](images/collections-new-collection.png)

The new collection appears in the tree and is ready to receive requests.

### Collection Settings

Right-click a collection and select **Settings** (or click the ⚙ icon) to open the Collection Settings modal.

![Collection settings modal](images/collections-settings-modal.png)

| Tab | What you can configure |
|---|---|
| **Authorization** | Default auth for all requests in the collection (Bearer, Basic, API Key, OAuth 2.0, etc.) |
| **Variables** | Collection-scoped variables available as `{{variableName}}` inside every request |
| **Pre-request Script** | Script that runs before every request in the collection |
| **Tests** | Test script that runs after every request in the collection |
| **Description** | Markdown description for the collection |

Collection-level auth is applied to any request whose own Auth tab is set to **Inherit auth from parent**. Scripts set at the collection level execute in addition to (and before) folder-level and request-level scripts.

### Folders

Folders let you group related requests inside a collection and apply shared settings to the group.

**Creating a folder:**
1. Right-click the collection (or an existing folder) and select **Add Folder**.
2. Name the folder and press `Enter`.

Folders support the same Settings modal as collections (Auth, Variables, Pre-request Script, Tests, Description), letting you apply different auth or scripts for different parts of the same collection.

**Nesting:** Folders can be nested to any depth. Drag and drop to reorder folders and requests within the tree.

---

## Requests

### Creating a Request

- Right-click a collection or folder and select **Add Request**.
- Or click the **+** icon next to any collection or folder row.

A new tab opens with an untitled request. Give it a name in the tab bar or save it (`Cmd+S` / `Ctrl+S`) — you will be prompted to name it.

![New request tab](images/collections-new-request.png)

### HTTP Methods

Select the method from the dropdown to the left of the URL bar.

| Method | Typical use |
|---|---|
| **GET** | Retrieve a resource |
| **POST** | Create a resource or submit data |
| **PUT** | Replace a resource entirely |
| **PATCH** | Partially update a resource |
| **DELETE** | Remove a resource |
| **HEAD** | Retrieve headers only (no body) |
| **OPTIONS** | Check allowed methods / CORS preflight |

The method badge is colour-coded in the collection tree and tab bar for quick visual identification.

### URL Bar

Type the full URL in the URL bar. You can use `{{variable}}` placeholders anywhere in the URL — they are resolved using the active environment and variable scopes before the request is sent.

```
https://{{baseUrl}}/api/users/{{userId}}?page=1
```

Press `Cmd+L` (macOS) / `Ctrl+L` (Windows/Linux) to focus the URL bar from anywhere.

Path variables (`:param` style) are not currently parsed automatically — use `{{variable}}` syntax instead and define the values in your environment.

### Query Parameters

![Query parameters tab](images/collections-query-params.png)

Open the **Params** tab to manage query string parameters as key/value pairs.

| Column | Description |
|---|---|
| Key | Parameter name |
| Value | Parameter value — supports `{{variable}}` |
| Description | Optional notes |
| ✓ (checkbox) | Enable or disable individual parameters without deleting them |

Parameters added in the Params tab are automatically appended to the URL bar. You can also type them directly in the URL bar — they will sync back to the Params tab.

**Bulk edit:** Click **Bulk Edit** to switch to a text-area mode where you can paste multiple `key: value` pairs at once.

### Request Headers

![Headers tab](images/collections-headers.png)

Open the **Headers** tab to add, edit, or disable individual headers.

| Column | Description |
|---|---|
| Key | Header name (case-insensitive) |
| Value | Header value — supports `{{variable}}` |
| Description | Optional notes |
| ✓ (checkbox) | Enable or disable individual headers |

Common headers (`Content-Type`, `Authorization`, `Accept`, etc.) are auto-suggested as you type.

**Bulk edit:** As with Params, a **Bulk Edit** mode allows pasting `key: value` pairs from clipboard.

> **Note:** Headers set in the Auth tab (e.g. `Authorization: Bearer …`) are injected automatically and do not need to be added manually here.

### Request Body

![Body tab](images/collections-body.png)

Open the **Body** tab to set the request payload. Choose the body mode from the radio buttons:

| Mode | Description | Auto-sets `Content-Type` |
|---|---|---|
| **None** | No body | — |
| **Raw** | Free-text editor (JSON, XML, HTML, plain text) | `application/json`, `text/html`, etc. |
| **URL-encoded** | Form fields as `application/x-www-form-urlencoded` | `application/x-www-form-urlencoded` |
| **Form-data** | Multipart form with optional file upload fields | `multipart/form-data` |
| **GraphQL** | Query + Variables JSON editor with introspection support | `application/json` |

**Raw mode language selector:** When using Raw mode, select the language (JSON, JavaScript, XML, HTML, Text) from the dropdown to get appropriate syntax highlighting with the One Dark theme. Press **⌘ F** / **Ctrl F** to search within the editor, or **⌘ H** / **Ctrl H** to open find-and-replace. See [Body Editor Find & Replace](#body-editor-find--replace) for details.

**Form-data file fields:** In Form-data mode, set a field's type to **File** to attach a binary file from your filesystem. The file is sent as a multipart part.

**`{{variable}}` substitution** works in all body modes — values are resolved at send time.

#### GraphQL

When **GraphQL** mode is selected, a second panel appears for the **Variables** JSON. Apilix also provides:

- **Introspection** — click **Fetch Schema** to load the schema from the endpoint. Once loaded, the query editor offers field autocomplete and inline documentation.
- The `operationName` field is sent automatically when the query contains named operations.

![GraphQL panel with introspection](images/collections-graphql.png)

### Authentication

Open the **Auth** tab to configure per-request authentication.

| Auth type | Fields |
|---|---|
| **No Auth** | No headers injected |
| **Inherit auth from parent** | Uses the nearest parent (folder or collection) auth setting |
| **Bearer Token** | `Authorization: Bearer <token>` |
| **Basic Auth** | `Authorization: Basic <base64(user:pass)>` |
| **API Key** | Custom header name + value (e.g. `X-API-Key`) |
| **OAuth 2.0** | Full OAuth 2.0 flow — see [Authentication](Authentication) |

Setting auth at the collection level and `Inherit` on each request means you only need to update credentials in one place.

### Pre-request & Test Scripts

Open the **Pre-req** and **Tests** tabs to write JavaScript scripts for this specific request.

- **Pre-request script** runs immediately before the request is sent — use it to set variables, sign requests, or fetch tokens.
- **Test script** runs after the response is received — use it to validate status codes, response bodies, and set variables for downstream requests.

Both tabs feature a Monaco editor with `apx.*` API autocomplete and syntax highlighting. See [Scripting](Scripting) for the full API reference.

A **Script Snippets Library** button opens a panel of reusable code snippets (HMAC signing, JWT generation, timestamp injection, etc.) that you can insert with a single click.

### Request Description

Open the **Settings** tab on a request to add a **Markdown description**. Descriptions are displayed in the collection tree tooltip and in exported Postman collections.

---

### MongoDB Requests

In addition to standard HTTP methods, Apilix supports **MongoDB** as a request type. Select `MONGO` from the method dropdown to switch the request into MongoDB mode.

- The **URL bar** is hidden — the panel switches to a dedicated MongoDB editor.
- The editor is organised into five tabs: **Query**, **Connection**, **Pre-request**, **Tests**, and **Docs**.
  - **Query** — database, collection, operation selector, and all operation-specific fields.
  - **Connection** — URI (direct or named connection) and optional auth override.
  - **Pre-request / Tests** — standard scripting tabs, identical to HTTP requests.
  - **Docs** — Markdown notes for this request.
- The **Database** and **Collection** fields include fetch buttons that query the live server and let you pick names from a dropdown, so you never have to type them manually.
- MongoDB requests can coexist with HTTP requests inside the same collection and run seamlessly in the Collection Runner.

See [MongoDB Requests](MongoDB-Requests) for a full reference on operations, connections, and scripting patterns.

---

## Sending a Request

Once the request is configured, send it by:

- Pressing `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux)
- Clicking the **Send** button to the right of the URL bar

While the request is in flight, a loading indicator appears in the tab. You can open another tab and work there without interrupting the in-flight request.

---

## Response Viewer

The Response Viewer appears below the Request Builder after a request completes.

![Response viewer overview](images/collections-response-viewer.png)

The summary bar at the top of the response shows:

| Indicator | Description |
|---|---|
| **Status** | HTTP status code and text (e.g. `200 OK`, `404 Not Found`) — colour-coded green/yellow/red |
| **Time** | Total round-trip time in milliseconds |
| **Size** | Response body size in KB / MB |

### Body Tab

The response body is displayed with **syntax highlighting** for JSON, XML, and HTML. You can toggle between:

- **Pretty** — formatted and highlighted
- **Raw** — unformatted plain text

Long JSON responses are fully scrollable. Use **Response Search** (`Ctrl+F`) to find text within large bodies.

### Headers Tab

Shows all response headers as a sortable key/value table. Common headers like `Content-Type`, `Cache-Control`, and `Set-Cookie` are displayed in full.

### Cookies Tab

Lists all cookies set by the response (parsed from `Set-Cookie` headers). Each row shows the cookie name, value, domain, path, expiry, and flags (`HttpOnly`, `Secure`, `SameSite`).

Cookies are automatically stored in the workspace cookie jar and sent on subsequent requests to the same domain.

### Timeline Tab

![Network timeline](images/collections-timeline.png)

The **Timeline** tab shows a waterfall breakdown of the request lifecycle:

| Phase | Description |
|---|---|
| **DNS** | Time spent resolving the hostname |
| **TCP** | Time to establish the TCP connection |
| **TLS** | Time to complete the TLS handshake (HTTPS only) |
| **TTFB** | Time to first byte — server processing time |
| **Download** | Time to transfer the full response body |
| **Total** | End-to-end duration |

Each phase is shown as a labelled bar with its exact millisecond duration. This is useful for identifying whether latency is in DNS, server processing, or transfer.

### TLS Certificate Tab

For HTTPS requests, the **TLS** tab shows the full server certificate chain. Each certificate in the chain displays:

| Field | Description |
|---|---|
| Subject | CN, O, OU, C fields |
| Issuer | Signing CA details |
| Valid From / To | Certificate validity window |
| Serial Number | Certificate serial |
| Fingerprint (SHA-1) | Hex fingerprint |
| Fingerprint (SHA-256) | Hex fingerprint |
| Subject Alt Names | SANs (domains / IPs covered by the cert) |
| Key Size (bits) | RSA/EC key size |

![TLS certificate chain](images/collections-tls-cert.png)

### Redirect Chain Tab

When the server returns one or more redirects (3xx responses), the **Redirects** tab lists every hop in the chain:

| Column | Description |
|---|---|
| URL | The URL that was requested at this hop |
| Status | HTTP status code of this hop (e.g. `301`, `302`) |
| Headers | Response headers at this hop |
| Time | Time spent at this hop |

The final entry is the resolved response. This is useful for debugging redirect loops, HTTPS upgrades, and canonical URL redirects.

![Redirect chain](images/collections-redirect-chain.png)

---

## Response Search

Press `Ctrl+F` while the response body is focused to open an inline search bar. Type a search term to highlight all matches and navigate between them with the arrow buttons. Search is case-insensitive by default.

---

## Body Editor Find & Replace

The raw body editors (Raw, GraphQL query, XML) support an inline find bar and a find-and-replace bar.

### Opening the bar

| Shortcut | Opens |
|---|---|
| **⌘ F** / **Ctrl F** | Find bar only |
| **⌘ H** / **Ctrl H** | Find + Replace bar |

Switch between modes using the **Find** and **Replace** tabs at the top of the toolbar. Press **Escape** to close.

### Navigating matches

- Matches are highlighted in the editor as you type.
- The bar shows the current match position as `2 / 5`.
- Press **Enter** in the search field to advance to the next match.
- Press **Shift+Enter** to go to the previous match.
- Click the **‹** and **›** buttons to navigate matches with the mouse.

### Replacing

1. Open Find & Replace (**⌘ H** / **Ctrl H**).
2. Type the search term and the replacement text.
3. Click **Replace** to replace the current match and advance to the next one.
4. Click **Replace All** to replace every match in one operation.

> Find & Replace only applies to the request body editor. It is not available in the response viewer (which is read-only). Use [Response Search](#response-search) to search response bodies.

---

## JSONPath / JMESPath Tester

The **expression tester** lets you write extraction expressions against the current response body without leaving Apilix.

![JSONPath tester](images/collections-jsonpath-tester.png)

1. After receiving a JSON response, click the **{ }** icon in the response toolbar.
2. Select the expression language: **JSONPath** or **JMESPath**.
3. Type your expression in the input field.
4. The result is displayed in real time below.

This is useful for:
- Building `pm.response.json()` extraction expressions for test scripts
- Verifying paths before using them in `apx.expect()` assertions
- Exploring deeply nested response structures

**Example expressions:**

| Expression | What it extracts |
|---|---|
| `$.users[0].email` (JSONPath) | First user's email from an array |
| `users[0].email` (JMESPath) | Same, JMESPath syntax |
| `$.data.items[?(@.active==true)]` (JSONPath) | Items where `active` is true |
| `data.items[?active]` (JMESPath) | Same, JMESPath syntax |

---

## Tabbed Editing

Apilix supports multiple request tabs open simultaneously.

![Tab bar with multiple open requests](images/collections-tabs.png)

| Action | Shortcut |
|---|---|
| Open a new empty request | `Cmd+N` / `Ctrl+N` |
| Close the current tab | `Cmd+W` / `Ctrl+W` |
| Save the current request | `Cmd+S` / `Ctrl+S` |
| Send the current request | `Cmd+Enter` / `Ctrl+Enter` |
| Focus the URL bar | `Cmd+L` / `Ctrl+L` |

Each tab maintains its own state independently — you can configure a POST request in one tab while reviewing the response to a GET in another. A dot indicator on the tab means there are unsaved changes.

---

## Collection Tree Actions

Right-clicking any item in the collection tree reveals a context menu:

**On a collection:**

| Action | Description |
|---|---|
| Add Request | Create a new request inside the collection |
| Add Folder | Create a new sub-folder |
| Settings | Open collection settings (Auth, Variables, Scripts, Description) |
| Rename | Inline rename |
| Duplicate | Deep-clone the entire collection |
| Export | Export as Postman v2.1 JSON, cURL, or Hurl |
| Order items A→Z | Sort all direct children of the collection alphabetically (visible when the collection has 2 or more items) |
| Delete | Delete the collection and all its contents |

**On a folder:**

| Action | Description |
|---|---|
| Add Request | Create a new request in this folder |
| Add Folder | Create a nested sub-folder |
| Settings | Folder auth, variables, and scripts |
| Rename | Inline rename |
| Duplicate | Deep-clone this folder and its contents |
| Order items A→Z | Sort the folder's direct children alphabetically (visible when the folder has 2 or more items) |
| Delete | Delete the folder and its contents |

**On a request:**

| Action | Description |
|---|---|
| Open | Open in a new tab |
| Rename | Inline rename |
| Duplicate | Clone this request in the same folder |
| Move to | Move the request to another collection/folder |
| Delete | Remove the request |

**Drag and drop:** Requests and folders can be reordered by dragging within the tree. Dragging across collections or folders moves the item. You can also drag an item directly onto a collection header — when the collection is closed or empty, it is highlighted with an orange ring and dropping appends the item to the collection's root.

---

## Cookie Manager

Click the **🍪 Cookies** button in the status bar (or open it from collection settings) to manage the workspace cookie jar.

![Cookie manager modal](images/collections-cookie-manager.png)

The Cookie Manager organises cookies by domain. For each domain you can:

- View all stored cookies and their attributes (value, path, expiry, `HttpOnly`, `Secure`, `SameSite`)
- Edit a cookie's value or flags
- Enable or disable individual cookies (disabled cookies are not sent)
- Delete individual cookies or clear all cookies for a domain

Cookies are sent automatically to matching domains on every request, respecting path, expiry, `Secure`, and `SameSite` constraints.

---

## Console Panel

The **Console** panel logs every request and response sent during the session, including resolved variable values (so you can see the actual URLs and headers that were used).

![Console panel](images/collections-console.png)

**Opening the console:**
- Click the console button in the **Status Bar** (bottom right)
- The button shows an unread-count badge when there are new entries

**Features:**
- Each entry shows the method, URL, status, response time, and size
- Expand an entry to see the full request headers, request body, response headers, and response body
- Variable values are shown post-resolution — useful for debugging `{{variable}}` substitution
- **Pop-out window:** Click **Pop Out** to detach the console into a separate live-updating window, so you can keep it visible while working in the main UI

The console is scoped to the current session and is cleared when you close the app.

---

## See Also

- [Variables & Environments](Variables-and-Environments) — use `{{variable}}` substitution in requests
- [Authentication](Authentication) — configure Bearer, Basic, API Key, and OAuth 2.0
- [Scripting](Scripting) — write pre-request and test scripts
- [Import & Export](Import-and-Export) — import Postman collections, OpenAPI specs, cURL, and more
- [Collection Runner](Collection-Runner) — run all requests in a collection automatically
