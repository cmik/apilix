# Import and Export

Apilix can exchange data with other tools through a variety of formats — both on the import side (bringing in requests from Postman, Insomnia, OpenAPI specs, HAR recordings, cURL commands, and HURL files) and on the export side (saving collections to Postman JSON, HAR, or HURL).

---

## Table of Contents

- [Import and Export](#import-and-export)
  - [Table of Contents](#table-of-contents)
  - [Opening the Import Dialog](#opening-the-import-dialog)
  - [Opening the Export Dialog](#opening-the-export-dialog)
  - [Import — Upload File](#import--upload-file)
  - [Import — JSON (Paste)](#import--json-paste)
  - [Import — Insomnia](#import--insomnia)
  - [Import — cURL](#import--curl)
    - [Steps](#steps)
  - [Import — HURL](#import--hurl)
    - [Steps](#steps-1)
  - [Import — OpenAPI / Swagger](#import--openapi--swagger)
    - [Paste spec text](#paste-spec-text)
    - [Import from URL](#import-from-url)
    - [Upload a spec file](#upload-a-spec-file)
    - [How endpoints are mapped](#how-endpoints-are-mapped)
  - [Import — HAR](#import--har)
    - [Steps](#steps-2)
  - [Export Formats](#export-formats)
    - [Postman JSON](#postman-json)
    - [HAR](#har)
    - [HURL](#hurl)
  - [Exporting — Web Mode](#exporting--web-mode)
  - [Exporting — Desktop (Electron)](#exporting--desktop-electron)
  - [Selecting Collections and Environments](#selecting-collections-and-environments)
  - [Format Reference](#format-reference)
  - [Common Workflows](#common-workflows)
    - [Import from Insomnia](#import-from-insomnia)
    - [Import from Postman](#import-from-postman)
    - [Seed a collection from an OpenAPI spec](#seed-a-collection-from-an-openapi-spec)
    - [Record browser traffic and export as HAR](#record-browser-traffic-and-export-as-har)
    - [Convert a cURL snippet from the browser](#convert-a-curl-snippet-from-the-browser)
    - [Export for use in CI](#export-for-use-in-ci)
    - [Backup your workspace](#backup-your-workspace)
    - [Share a workspace without sync](#share-a-workspace-without-sync)

---

## Opening the Import Dialog

Click **Import** in the Sidebar toolbar (or use the keyboard shortcut) to open the Import modal. Six tabs are available across the top of the modal:

| Tab | What it imports |
|---|---|
| **Upload File** | Any supported file type via file picker or drag-and-drop |
| **JSON** | Postman Collection v2.1, Environment JSON, or Insomnia export (v4 JSON / v5 YAML) pasted as text |
| **cURL** | A single `curl` command pasted as text |
| **HURL** | One or more requests in HURL format |
| **OpenAPI** | OpenAPI 3.x or Swagger 2.0 spec (YAML or JSON) — paste, URL, or file |
| **HAR** | HTTP Archive (HAR) JSON pasted as text |

---

## Opening the Export Dialog

Click **Export** in the Sidebar toolbar to open the Export modal. Choose a format, select which collections (and environments) to export, then click **Export**.

---

## Import — Upload File

The **Upload File** tab accepts files via a click-to-browse picker or by dragging and dropping files onto the panel. Multiple files can be selected at once.

![Import — Upload File tab](images/import-upload-file.png)

**Accepted file types:**

| Extension | Detected as |
|---|---|
| `.json` (with `__export_format: 4` + `resources` keys) | Insomnia v4 export |
| `.yaml` / `.yml` (with `type: collection.insomnia.rest/…` key) | Insomnia v5 export |
| `.json` (with `info` + `item` keys) | Postman Collection v2.1 |
| `.json` (with `name` + `values` keys) | Postman Environment |
| `.json` / `.yaml` / `.yml` (with `openapi` or `swagger` key) | OpenAPI / Swagger spec |
| `.hurl` | HURL request file |
| `.har` | HTTP Archive |

Auto-detection reads the file extension first. For `.json` files without a clear extension hint, the file contents are inspected to determine the format.

Each file is processed independently. Success and error messages are shown after each file is parsed.

---

## Import — JSON (Paste)

The **JSON** tab accepts raw JSON pasted into a text area.

**Supported payloads (auto-detected):**

- **Insomnia v4 export (JSON)** — must contain `__export_format: 4` and a `resources` array. Creates one collection per workspace and one environment per named environment with data.
- **Insomnia v5 export (YAML or JSON)** — must contain `type: collection.insomnia.rest/5.x` and a `collection` array. Creates one collection and optionally one environment.
- **Postman Collection v2.1** — must contain `info` and `item` keys. Creates a new collection.
- **Postman Environment** — must contain `name` and `values` keys. Creates a new environment.
- **OpenAPI / Swagger JSON** — if the pasted object contains an `openapi` or `swagger` root key, it is parsed as an OpenAPI spec and a new collection is created.

See [Import — Insomnia](#import--insomnia) for full details on both Insomnia formats.

Click **Import** after pasting. An error is shown if the JSON is malformed or in an unrecognised format.

---

## Import — Insomnia

Apilix imports both **Insomnia v4** (`.json`, legacy format) and **Insomnia v5** (`.yaml`/`.yml`, produced by Insomnia 10+). Both formats are auto-detected — no manual format selection is needed.

### Insomnia v4 (JSON)

Produced by **Insomnia ≤ 9** via the Application Menu → Preferences → Data → Export Data.

#### Steps

1. In Insomnia, open **Application Menu → Preferences → Data → Export Data**.
2. Select **All** or choose specific workspaces. Keep the format as **Insomnia v4** and save the `.json` file.
3. In Apilix: **Import → Upload File** → select the file (or drag and drop it onto the panel).
   Alternatively: **Import → JSON** → paste the file contents.
4. Apilix shows a confirmation: `Insomnia import: N collection(s), M environment(s).`

**What gets imported:** One **collection per workspace**. Request groups (folders) become nested folders (unlimited depth). Each workspace's named environments with at least one variable become Apilix environments.

### Insomnia v5 (YAML)

Produced by **Insomnia 10+** via the collection **Export** button in the top-right of the collection view.

#### Steps

1. In Insomnia, open the collection you want to export.
2. Click the **⋮ menu → Export** and save the `.yaml` file.
3. In Apilix: **Import → Upload File** → select the `.yaml` file (or drag and drop it).
   Alternatively: **Import → JSON** → paste the YAML text.
4. Apilix shows a confirmation: `Insomnia import: 1 collection(s), M environment(s).`

**What gets imported:** One **collection** with all requests from the flat `collection[]` array. If the `environments` block has at least one variable, one Apilix environment is created.

> **Note:** Insomnia v5 exports one collection per file. If you have multiple collections, export them separately and import each file.

### What gets imported — request fields

This mapping applies to both v4 and v5 requests.

| Insomnia field | Apilix mapping |
|---|---|
| `method` | HTTP method (uppercased; defaults to `GET` if empty) |
| `url` | Request URL |
| `headers` | Request headers (disabled headers are excluded) |
| `parameters` | URL query parameters (disabled params are excluded) |
| `body` | Request body — see [Body types](#body-types) below |
| `authentication` | Request auth — see [Auth types](#auth-types) below |
| `description` | Request description |

#### Body types

| Insomnia `mimeType` | Apilix body mode |
|---|---|
| `application/json` | Raw (language: JSON) |
| `text/plain`, `text/html` | Raw (language: text) |
| `text/xml`, `application/xml` | Raw (language: XML) |
| `application/x-www-form-urlencoded` | URL-encoded form (disabled params excluded) |
| `multipart/form-data` | Form data (disabled params excluded) |
| `application/graphql` | GraphQL (query + variables extracted) |
| other / empty | Raw fallback if text is present; otherwise no body |

#### Auth types

| Insomnia `authentication.type` | Apilix auth type |
|---|---|
| `bearer` | Bearer Token |
| `basic` | Basic Auth (username + password) |
| `apikey` | API Key (header or query, depending on `addTo`) |
| `oauth2` | OAuth 2.0 (token must be configured manually after import) |
| anything else, or `disabled: true` | No auth |

#### Environments

Each Insomnia `environment` resource with at least one variable is imported as an **Apilix environment**. The environment name is preserved.

Insomnia stores variable values as plain text, numbers, or booleans. Apilix converts all values to strings; non-string values are serialised with `JSON.stringify`.

> **Note about base environments:** Insomnia creates a hidden "Base Environment" per workspace alongside named sub-environments. If the base environment has variables defined, it appears as a regular environment in Apilix. Base and named environments are imported as peers — Apilix does not have an environment hierarchy.

### Variable syntax compatibility

Both Insomnia and Apilix use `{{variableName}}` syntax for variable references. No conversion is needed — URLs, headers, and body text that reference `{{vars}}` work immediately after import.

---

## Import — cURL

The **cURL** tab converts a single `curl` command into a collection request.

![Import — cURL tab](images/import-curl.png)

### Steps

1. Select the **target collection** from the dropdown. The request is appended to this collection. You must have at least one collection before importing a cURL command.
2. Paste the complete `curl` command into the text area.
3. Click **Import**.

**What gets parsed:**

| cURL flag | Mapped to |
|---|---|
| `-X` / `--request` | HTTP method |
| URL argument | Request URL |
| `-H` / `--header` | Request header |
| `-d` / `--data` / `--data-raw` | Raw body (`Content-Type` determines language) |
| `--data-urlencode` | URL-encoded form body |
| `-F` / `--form` | Multipart form body |
| `-u` / `--user` | Basic Auth (username + password) |

The imported request is named from the last path segment of the URL (e.g. `POST /users` → `users`).

---

## Import — HURL

[HURL](https://hurl.dev/) is a plain-text HTTP request format. A single `.hurl` file can contain multiple requests separated by blank lines.

![Import — HURL tab](images/import-hurl.png)

### Steps

1. Optionally select a **target collection**. If a collection is selected, all parsed requests are appended to it. If no collection exists yet, Apilix creates a new one named `HURL Import`.
2. Paste the HURL content into the text area.
3. Click **Import**.

**Minimal HURL syntax supported:**

```hurl
GET https://api.example.com/users
Authorization: Bearer {{token}}

HTTP *


POST https://api.example.com/users
Content-Type: application/json

{"name": "Alice"}

HTTP *
```

> Each request starts with a method line (`GET`, `POST`, `PUT`, etc.) followed by the URL. Headers follow immediately. The body (if any) comes after a blank line. `HTTP *` is an optional assertion line that Apilix ignores on import.

Requests are appended to an existing collection or a new `HURL Import` collection is created if none exists.

---

## Import — OpenAPI / Swagger

The **OpenAPI** tab imports an OpenAPI 3.x or Swagger 2.0 specification and converts each endpoint into a collection request.

![Import — OpenAPI tab](images/import-openapi.png)

### Paste spec text

Paste a YAML or JSON spec directly into the text area, then click **Import from text**.

### Import from URL

Enter the public URL of the spec (e.g. `https://petstore3.swagger.io/api/v3/openapi.json`) and click **Import from URL**. Apilix fetches the spec server-side, parses it, and creates a collection.

### Upload a spec file

Switch to the **Upload File** tab and drop a `.yaml`, `.yml`, or `.json` OpenAPI file — it is detected automatically.

### How endpoints are mapped

| OpenAPI concept | Apilix mapping |
|---|---|
| `info.title` | Collection name |
| `tags` | Collection folders (one folder per tag) |
| Untagged operations | Top-level items in the collection |
| `parameters` (query) | Query params on the URL |
| `parameters` (header) | Request headers |
| `parameters` (path) | Path variables (e.g. `{id}` → `{{id}}`) |
| `requestBody` — `application/json` | JSON body (with example values filled in) |
| `requestBody` — `application/x-www-form-urlencoded` | URL-encoded form body |
| `servers[0].url` | Base URL prepended to each path |
| Global `securitySchemes` (Bearer, API Key, OAuth2) | Collection-level auth |

`operationId` is used as the request name when available; otherwise `METHOD /path` is used.

---

## Import — HAR

The **HAR** tab imports an HTTP Archive file that was exported from browser DevTools, Apilix Browser Capture, or another proxy tool.

![Import — HAR tab](images/import-har.png)

### Steps

1. Paste the HAR JSON into the text area.
2. Click **Import**.

A new collection named `HAR Import` is created containing one request per HAR entry (only `log.entries` is read). The collection name is taken from the filename when imported via the **Upload File** tab.

**What gets imported from each HAR entry:**

| HAR field | Mapped to |
|---|---|
| `request.method` | HTTP method |
| `request.url` | URL (parsed into host, path, query) |
| `request.headers` | Request headers |
| `request.postData` | Body (mode detected from `mimeType`) |

Response data is not imported.

---

## Export Formats

Three formats are available from the Export modal:

| Format | Button label | File extension | Includes environments |
|---|---|---|---|
| **Postman JSON** | Postman JSON | `*.postman_collection.json` | Yes (`*.postman_environment.json`) |
| **HAR** | HAR | `*.har` | No |
| **HURL** | HURL | `*.hurl` | No |

Select the format using the three-button toggle at the top of the Export modal.

### Postman JSON

Exports each selected collection as a **Postman Collection v2.1** JSON file. Includes the collection's auth settings, pre/post scripts, and collection-level variables.

When environments are selected, each is exported as a separate `*.postman_environment.json` file that can be imported directly into Postman, Insomnia, or another Apilix instance.

### HAR

Exports each selected collection as an **HTTP Archive (HAR)** file. HAR files can be loaded into browser DevTools, Charles Proxy, Fiddler, or any HAR-compatible tool for replay or analysis.

### HURL

Exports each selected collection as a **HURL** plain-text file. HURL is a simple, VCS-friendly format runnable with the `hurl` CLI tool.

---

## Exporting — Web Mode

In browser mode, each file is downloaded individually using the browser's native download mechanism. If multiple collections are selected, one download is triggered per collection (plus one per environment in Postman JSON format).

![Export modal — web mode](images/export-modal-web.png)

---

## Exporting — Desktop (Electron)

In the desktop app, clicking **Export** opens a **folder picker** dialog. All selected files are written directly to the chosen folder in a single operation — no individual save dialogs.

![Export modal — desktop folder picker](images/export-modal-desktop.png)

This is particularly useful for batch exports: select 10 collections, pick an output folder, and all 10 files are written at once.

---

## Selecting Collections and Environments

The Export modal lists all collections and (in Postman JSON mode) all environments with checkboxes.

| Action | How |
|---|---|
| Select / deselect one | Click its checkbox |
| Select all | Click **Select all** next to the section heading |
| Deselect all | Click **Deselect all** |
| Filter the list | A search box appears automatically when you have more than 6 collections or environments |

The heading shows a running count: `Collections (3/10)`.

> Environments are only shown when **Postman JSON** format is selected. HAR and HURL exports do not include environment data.

---

## Format Reference

| Format | Import | Export | Use case |
|---|---|---|---|
| Insomnia v4 JSON | ✅ | — | Migrate from Insomnia ≤ 9 (multi-workspace, collections + environments) |
| Insomnia v5 YAML | ✅ | — | Migrate from Insomnia 10+ (single collection + environment per file) |
| Postman Collection v2.1 JSON | ✅ | ✅ | Share with Postman / other Apilix users |
| Postman Environment JSON | ✅ (import) | ✅ (Postman format) | Move environments between tools |
| OpenAPI 3.x / Swagger 2.0 | ✅ (YAML + JSON + URL) | — | Bootstrap collection from an API spec |
| HAR | ✅ | ✅ | Browser DevTools → Apilix, proxy recordings |
| HURL | ✅ | ✅ | Text-based CI/CD-friendly HTTP requests |
| cURL | ✅ (single command) | — | Copy from browser DevTools → Apilix |
| **Apilix Workspace Export** | ✅ (via Manage Workspaces) | ✅ (via Manage Workspaces) | Full workspace backup and transfer between Apilix instances |
| **Apilix Sync Config Export** | ✅ (via Manage Workspaces) | ✅ (via Sync tab) | Move sync credentials to a new machine |

---

## Common Workflows

### Import from Insomnia

**Insomnia ≤ 9 (v4 JSON):**

1. Open the **Application Menu → Preferences → Data → Export Data**.
2. Select **All workspaces** (or choose specific ones). Keep the format as **Insomnia v4**. Save the `.json` file.
3. In Apilix: **Import → Upload File** → select the exported `.json` file.
4. All workspaces become collections and all named environments with variables are created automatically.

**Insomnia 10+ (v5 YAML):**

1. Open the collection you want to export.
2. Click the **⋮ menu → Export** and save the `.yaml` file.
3. In Apilix: **Import → Upload File** → select the `.yaml` file.
4. One collection is created; if the base environment has variables, one environment is created.

**Both formats:**

- Variable syntax (`{{variableName}}`) is identical between Insomnia and Apilix — no conversion needed.
- If your requests use `{{variables}}`, verify those values are set in the corresponding Apilix environment after import.

> **OAuth 2.0 note:** Insomnia's OAuth 2 configuration (client ID, secret, token URL, scopes) is not transferable from the export format. Apilix creates the auth entry with type `oauth2` but the credentials must be re-entered in the request's **Auth** panel after import.

### Import from Postman

1. In Postman: **File → Export** → **Collection v2.1** → save the `.json` file.
2. In Apilix: **Import → Upload File** → select the file.
3. The collection appears in your sidebar immediately.

To also migrate environments:
1. In Postman: **Environments** → export each environment as JSON.
2. In Apilix: **Import → Upload File** → select the environment files.

### Seed a collection from an OpenAPI spec

1. **Import → OpenAPI** → paste your spec or enter the spec URL.
2. Apilix creates a collection with folders matching your API tags.
3. Rename the collection and add environment variables for the base URL and auth tokens.

### Record browser traffic and export as HAR

1. Open your browser DevTools → **Network** tab.
2. Perform the actions you want to capture.
3. Right-click any request → **Save all as HAR with content**.
4. In Apilix: **Import → Upload File** → select the `.har` file.

Alternatively, use [Browser Capture](Browser-Capture.md) to record directly into Apilix without leaving the app.

### Convert a cURL snippet from the browser

1. In your browser DevTools → **Network** tab → right-click a request → **Copy as cURL**.
2. In Apilix: **Import → cURL** → select a target collection → paste → **Import**.

### Export for use in CI

1. **Export** → select **HURL** format.
2. Choose the collections to export.
3. The generated `.hurl` files can be run directly with:
   ```bash
   hurl --variable token=$API_TOKEN my-collection.hurl
   ```

### Backup your workspace

Use the workspace export feature to create a portable backup of an entire workspace, including all collections, environments, variables, the cookie jar, and mock server routes.

1. Open **Manage Workspaces** (gear icon in the sidebar).
2. Find the workspace row and click the **⬇** export button.
3. A file named `apilix-workspace-{name}.json` is downloaded.

To restore later, or copy to another machine:

1. Open **Manage Workspaces → Workspaces** tab.
2. Click **↑ Import workspace file** (or drag and drop the file onto that area).
3. Review the confirmation card and click **Import workspace**.

> The workspace export includes collections, environments, variables, cookie jar, and mock routes. It does **not** include sync credentials, snapshot history, or request logs. See [Workspaces — Exporting and Importing](Workspaces#exporting-and-importing-workspaces) for full details.

### Share a workspace without sync

If a colleague does not use the same sync provider, export the workspace and send them the file:

1. Export the workspace using the **⬇** button in the workspace row.
2. Send the `.json` file (email, file share, etc.).
3. On the other machine: **Manage Workspaces → Workspaces** → drag the file onto the **↑ Import workspace file** zone → click **Import workspace**.
