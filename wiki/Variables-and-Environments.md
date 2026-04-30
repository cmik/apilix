# Variables & Environments

Apilix supports `{{variable}}` substitution everywhere — in URLs, query parameters, headers, request bodies, and scripts. Variables are organised into four scopes with a clear priority order, so you can override values at different levels without duplicating data.

---

## Table of Contents

- [Variables \& Environments](#variables--environments)
  - [Table of Contents](#table-of-contents)
  - [Variable Syntax](#variable-syntax)
    - [Variable Autocomplete](#variable-autocomplete)
  - [Scope Hierarchy](#scope-hierarchy)
  - [Environments](#environments)
    - [Creating an Environment](#creating-an-environment)
    - [Switching the Active Environment](#switching-the-active-environment)
    - [Editing Variables](#editing-variables)
    - [Enabling and Disabling Variables](#enabling-and-disabling-variables)
    - [Marking Variables as Secret](#marking-variables-as-secret)
  - [Global Variables](#global-variables)
  - [Collection Variables](#collection-variables)
  - [Data Row Variables (Runner)](#data-row-variables-runner)
  - [Variable Scope Inspector](#variable-scope-inspector)
  - [Variable Name Rules](#variable-name-rules)
  - [Setting Variables from Scripts](#setting-variables-from-scripts)
    - [Reading variables](#reading-variables)
    - [Writing variables](#writing-variables)
    - [Unsetting variables](#unsetting-variables)
    - [Checking if a variable is defined](#checking-if-a-variable-is-defined)
  - [Common Patterns](#common-patterns)
    - [Pattern 1: Base URL per environment](#pattern-1-base-url-per-environment)
    - [Pattern 2: Capture a token after login](#pattern-2-capture-a-token-after-login)
    - [Pattern 3: Chain requests with collection variables](#pattern-3-chain-requests-with-collection-variables)
    - [Pattern 4: Data-driven testing with CSV](#pattern-4-data-driven-testing-with-csv)
  - [See Also](#see-also)

---

## Variable Syntax

Use double curly braces to reference a variable anywhere in a request:

```
{{variableName}}
```

Variables are resolved at send time — the raw template is stored, not the resolved value. If a variable cannot be resolved (no matching key in any scope), it is left as-is in the sent request.

**Where `{{variable}}` works:**

| Location | Example |
|---|---|
| URL | `https://{{baseUrl}}/api/v{{version}}/users` |
| Query parameter value | `?limit={{pageSize}}` |
| Header value | `Authorization: Bearer {{accessToken}}` |
| Request body (raw JSON) | `{"userId": "{{userId}}"}` |
| Form-data field value | `{{formField}}` |
| Pre-request script | `const url = apx.variables.get('baseUrl')` |
| Test script | `apx.expect(apx.variables.get('userId')).to.be.a('string')` |

Variable names are **case-sensitive**. Whitespace inside `{{ }}` is trimmed automatically, so `{{ baseUrl }}` resolves the same as `{{baseUrl}}`.

See [Variable Name Rules](#variable-name-rules) for the full set of constraints that apply when you save or import variables.

### Variable Autocomplete

In every text input that accepts `{{variable}}` tokens — URL bar, query parameters, headers, body form fields, path parameters, auth fields, and collection variable values — Apilix shows an autocomplete dropdown as you type.

- Start typing `{{` to open the picker immediately.
- Continue typing to filter suggestions by variable name.
- Navigate with **↑ / ↓** arrow keys; confirm with **Enter** or **Tab**; dismiss with **Escape**.
- Each suggestion shows the variable name and its current resolved value (truncated to 36 characters) so you can pick the right one at a glance.

The suggestion list is drawn from all variables currently in scope (environment, collection, and globals) at the time you are editing.

---

## Scope Hierarchy

When the same variable name exists in multiple scopes, the highest-priority scope wins. The resolution order from highest to lowest is:

```
Data Row  >  Environment  >  Collection  >  Globals
```

| Scope | Badge | Description | Set by |
|---|---|---|---|
| **Data Row** | `DATA` | Values from the current CSV row in the Collection Runner | Runner CSV file |
| **Environment** | `ENV` | Active environment's key/value pairs | Environments panel |
| **Collection** | `COLL` | Variables scoped to a specific collection | Collection Settings → Variables tab |
| **Globals** | `GLOBAL` | Cross-collection workspace variables | Globals panel or scripts |

**Example:**

If `baseUrl` is defined in both Globals (`https://prod.api.com`) and the active Environment (`https://staging.api.com`), the Environment value wins — `{{baseUrl}}` resolves to `https://staging.api.com`.

---

## Environments

An environment is a named set of key/value pairs. Only one environment can be active at a time per workspace. Switching environments instantly changes all resolved variable values across every open tab.

Common use: one environment per deployment tier.

```
Production  →  baseUrl = https://api.example.com
Staging     →  baseUrl = https://staging.api.example.com
Local       →  baseUrl = http://localhost:8080
```

### Creating an Environment

1. Click the **🌍 Environments** icon in the Activity Bar (or open the **Environments** view from the sidebar).
2. Click **+ New Environment**.
3. Enter a name (e.g. `Production`) and press Enter.
4. The environment editor opens — add variables as described below.

![Create new environment](images/variables-new-environment.png)

### Switching the Active Environment

The active environment is shown in the **Status Bar** at the bottom of the window.

To change it:
- Click the environment name in the Status Bar to open a quick-switcher dropdown.
- Or open the Environments view and click **Set Active** next to any environment.

Selecting **No Environment** disables environment-level substitution — only Globals and Collection variables are active.

### Editing Variables

In the Environments view, select an environment to open its editor.

![Environment editor](images/variables-environment-editor.png)

Each row in the variable table has:

| Column | Description |
|---|---|
| ✓ | Enable/disable toggle — disabled variables are skipped during resolution |
| **Variable** | Key name — referenced as `{{key}}` |
| **Current Value** | The value used during resolution |

**Adding a variable:** Click **+ Add Variable** at the bottom of the table, or simply start typing in the empty row.

**Editing:** Click any cell to edit inline. Changes take effect immediately — no need to save separately (use the **Save** button to persist to disk).

**Deleting:** Click the ✕ icon at the end of a row to remove a variable.

**Variable name validation:** The key field validates the name in real time as you type. The border turns red and an inline error message appears if the name is invalid. The **Save** button is disabled until all errors are resolved. See [Variable Name Rules](#variable-name-rules) for the complete list of constraints.

### Enabling and Disabling Variables

The checkbox in the first column controls whether a variable participates in resolution. Disabled variables are greyed out and will not override variables from lower-priority scopes.

This is useful when you need to temporarily bypass a variable (e.g. to test a default fallback value) without deleting it.

### Marking Variables as Secret

In the Environment editor, use the **lock** control on a row to mark a value as secret.

- Secret values are visually hidden in the editor.
- In the desktop app (Electron), secret values are encrypted at rest using the OS keychain.
- Secret values are used by the optional UI redaction layer in Console and Request History when **Mask secret variable values in console, logs, and history** is enabled.

> The secret flag does not remove the value from runtime request execution. It is still resolved and sent normally where referenced.

---

## Global Variables

Global variables are **cross-collection** — they are available in every collection in the active workspace, at the lowest priority scope.

**Access the Globals panel:**
- Click the **🌐 Globals** tab in the Environments/Globals/Variables panel.
- Or click the **Globals** icon in the Activity Bar.

> Variable name validation applies here too — the **Save** button is disabled when any key is invalid. See [Variable Name Rules](#variable-name-rules).

![Globals panel](images/variables-globals-panel.png)

The Globals editor works exactly like the Environment editor: key/value rows with enable/disable toggles.

**Typical use cases for globals:**

| Variable | Example value | Description |
|---|---|---|
| `apiVersion` | `v2` | Shared API version prefix |
| `defaultTimeout` | `5000` | Timeout in ms — read in pre-request scripts |
| `sharedToken` | `eyJ…` | Token set by a script after a login request |

Globals can be read and written from scripts using:

```js
apx.globals.get('sharedToken')
apx.globals.set('sharedToken', apx.response.json().token)
```

---

## Collection Variables

Collection variables are scoped to a single collection. They are available to all requests in that collection and its folders, but not to other collections.

**Setting collection variables:**
1. Right-click the collection in the tree and select **Settings**.
2. Open the **Variables** tab.
3. Add key/value rows.

Each key input validates in real time; invalid names are highlighted with a red border and an inline error message. The modal's **Save** button is disabled until all keys are valid. See [Variable Name Rules](#variable-name-rules).

![Collection variables in settings](images/variables-collection-settings.png)

Collection variables are read and written from scripts using:

```js
apx.collectionVariables.get('endpoint')
apx.collectionVariables.set('endpoint', '/api/v2')
```

**Typical use cases:**

| Variable | Example value |
|---|---|
| `collectionBaseUrl` | `https://service.internal` |
| `resourceId` | Set by a "create resource" request, used by subsequent requests |
| `authToken` | Set in a pre-request script for requests in this collection only |

---

## Data Row Variables (Runner)

When running a collection with a **CSV data file**, each row of the CSV becomes one iteration. The column headers become variable names, and each row's cell values override all other scopes for that iteration.

```csv
userId,role,expectedStatus
1,admin,200
2,editor,200
99,viewer,403
```

In this example, during iteration 1, `{{userId}}` resolves to `1`, `{{role}}` to `admin`, and `{{expectedStatus}}` to `200`.

Data row variables have the **highest priority** — they override Globals, Collection variables, and even the active Environment for the duration of that iteration.

See [Collection Runner](Collection-Runner) for the full CSV workflow.

---

## Variable Scope Inspector

The **Scope Inspector** shows every variable currently defined across all four scopes, de-duplicated, displaying which scope wins for each name.

**Opening the Scope Inspector:**
- Click the **🔍 Scope Inspector** tab in the Environments/Globals/Variables panel.
- Or click the **Variables** icon in the Activity Bar.

![Variable Scope Inspector](images/variables-scope-inspector.png)

Each variable is listed with:

| Column | Description |
|---|---|
| **Name** | The `{{variableName}}` key |
| **Resolved value** | The value that will actually be used (from the winning scope) |
| **Scope badge** | `ENV`, `COLL`, or `GLOBAL` — indicates which scope is providing the resolved value |
| **Overridden values** | Lower-priority scopes that define the same name (shown greyed out) |

**Filtering:** Type in the search box to filter variables by name.

The Scope Inspector is read-only — edit values in the respective panel (Environments, Globals, or Collection Settings).

**Secret variables:** Environment variables marked as secret (🔒) have their values hidden by default in both the *Resolved Variables* table and the *By Scope* section. Click the eye / eye-off icon next to a masked value to temporarily reveal it. Clicking again re-masks it. Reveal state is not persisted and resets when you navigate away.

---

## Variable Name Rules

These rules apply everywhere you can create or edit a variable key — in environment editors, the Globals panel, collection variable settings, and at import time.

### Allowed characters

A variable name may contain any character **except** whitespace and curly braces `{` `}`.

| ✅ Valid | ❌ Invalid |
|---|---|
| `accessToken` | `access token` (space) |
| `api-key` | `{{token}}` (braces) |
| `X-Request-ID` | `my\tvar` (tab) |
| `base_url_v2` | `key name` (leading space) |

### Real-time validation

All variable editors validate key names as you type:

- The key input border turns **red** if the name is invalid.
- An **inline error message** appears below the offending row immediately.
- The **Save** button is disabled until all errors are resolved — you cannot accidentally persist an invalid name.
- Empty rows (no key entered) are silently filtered out on save — they do not trigger a validation error.

### Normalization on save

When you click **Save**, any leading or trailing whitespace in a key is automatically stripped before the variable is stored. An internal space (e.g. `my token`) is **not** silently converted — it triggers a validation error that must be fixed first.

### At import time

When importing environments from Postman JSON, Insomnia v4, or Insomnia v5 files, all variable keys are automatically trimmed of surrounding whitespace. Keys that are empty after trimming are dropped silently.

### In scripts

Key arguments passed to `apx.environment.set()`, `apx.globals.set()`, and `apx.collectionVariables.set()` are automatically trimmed of leading and trailing whitespace at runtime. This means `apx.environment.set('  token  ', value)` stores the value under the key `token`.

---

## Setting Variables from Scripts

Variables can be created, read, and updated at runtime from pre-request or test scripts using the `apx.*` API.

### Reading variables

```js
// Resolved value (highest-priority scope wins)
const base = apx.variables.get('baseUrl');

// Scope-specific getters
const env   = apx.environment.get('accessToken');
const coll  = apx.collectionVariables.get('resourceId');
const glob  = apx.globals.get('sharedSecret');
```

### Writing variables

```js
// Set in a specific scope
apx.environment.set('accessToken', apx.response.json().token);
apx.collectionVariables.set('createdId', apx.response.json().id);
apx.globals.set('sessionId', apx.response.json().session);
```

### Unsetting variables

```js
apx.environment.unset('accessToken');
apx.collectionVariables.unset('createdId');
apx.globals.unset('sessionId');
```

### Checking if a variable is defined

```js
const hasToken = apx.environment.has('accessToken'); // → true / false
```

> **Scope note:** `apx.variables.set()` is not supported. Use the scope-specific setters (`apx.environment.set`, `apx.collectionVariables.set`, `apx.globals.set`) to be explicit about where the value is stored.

---

## Common Patterns

### Pattern 1: Base URL per environment

Define `baseUrl` in each environment, then use it everywhere:

**Environments:**
```
Production  →  baseUrl = https://api.example.com
Staging     →  baseUrl = https://staging.api.example.com
```

**Request URL:**
```
{{baseUrl}}/users/{{userId}}
```

Switch environments to instantly retarget all requests.

---

### Pattern 2: Capture a token after login

Use a test script on the login request to capture the token and store it for all subsequent requests:

```js
// Test script on POST /auth/login
const json = apx.response.json();
apx.environment.set('accessToken', json.token);
```

Then in every other request's Auth tab, use **Bearer Token** with `{{accessToken}}`.

---

### Pattern 3: Chain requests with collection variables

Request 1 — create a resource, capture its ID:

```js
// Test script on POST /resources
apx.collectionVariables.set('resourceId', apx.response.json().id);
```

Request 2 — use the captured ID:

```
GET {{baseUrl}}/resources/{{resourceId}}
```

---

### Pattern 4: Data-driven testing with CSV

```csv
email,password,expectedStatus
valid@example.com,correct,200
valid@example.com,wrong,401
notauser@example.com,anything,404
```

**Request URL:** `POST {{baseUrl}}/auth/login`

**Body:**
```json
{
  "email": "{{email}}",
  "password": "{{password}}"
}
```

**Test script:**
```js
apx.test('status matches expected', () => {
  apx.expect(apx.response.code).to.equal(parseInt(apx.iterationData.get('expectedStatus')));
});
```

---

## See Also

- [Collection Runner](Collection-Runner) — CSV data-driven testing with data row variables
- [Scripting](Scripting) — full `apx.*` variable API reference
- [Variable Scope Inspector](#variable-scope-inspector) — visualise resolved values across all scopes
- [Collections & Requests](Collections-and-Requests) — collection-level variable settings
