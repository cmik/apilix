# Response Schemas

A response schema is a named [JSON Schema](https://json-schema.org/) that describes the body of an API response. Apilix keeps your schemas in a workspace-level library, can infer a first draft from a real response, lets you link a schema to a request for each response status (`200`, `4xx`, `default`), and then checks every response against it, in the response viewer, in the Collection Runner, in the headless CLI, and from scripts with `matchSchema()`. In this version, schemas apply to **JSON** response bodies only.

---

## Table of Contents

- [Response Schemas](#response-schemas)
  - [Table of Contents](#table-of-contents)
  - [Concepts](#concepts)
  - [Creating a Schema](#creating-a-schema)
    - [Infer from the Last Response](#infer-from-the-last-response)
    - [Inference Options](#inference-options)
    - [Write or Import a Schema](#write-or-import-a-schema)
    - [Reuse Other Schemas with `$ref`](#reuse-other-schemas-with-ref)
  - [Linking a Schema to a Request](#linking-a-schema-to-a-request)
    - [Status Matching](#status-matching)
    - [Link Mode](#link-mode)
  - [Checking a Response in the App](#checking-a-response-in-the-app)
  - [The Schema Library](#the-schema-library)
    - [Version History](#version-history)
    - [Import and Export of Schema Files](#import-and-export-of-schema-files)
  - [Schema Checks in the Collection Runner](#schema-checks-in-the-collection-runner)
    - [The Schema Mode Ceiling](#the-schema-mode-ceiling)
    - [What Counts as a Violation](#what-counts-as-a-violation)
  - [Schema Checks in the CLI](#schema-checks-in-the-cli)
    - [Flags and Environment Variable](#flags-and-environment-variable)
    - [Where the CLI Reads Schemas and Links](#where-the-cli-reads-schemas-and-links)
    - [Reporters and Exit Codes](#reporters-and-exit-codes)
    - [Standalone Binary Caveat](#standalone-binary-caveat)
  - [Validation Time Limit](#validation-time-limit)
  - [Scripting: `matchSchema()`](#scripting-matchschema)
  - [Postman Import and Export](#postman-import-and-export)
  - [Sync Conflicts](#sync-conflicts)
  - [HTTP API](#http-api)
  - [Limits and Known Gaps](#limits-and-known-gaps)
  - [See Also](#see-also)

---

## Concepts

| Term | Meaning |
|---|---|
| **Schema** | A named JSON Schema object with a description, a version number, and a short history of earlier versions. Names are unique in the workspace, ignoring case. |
| **Schema library** | The list of all schemas of the active workspace. Open it with **Schemas** in the Activity Bar. Schemas belong to the workspace, not to a single collection, so several collections can share them. |
| **Link** | The association of one schema with one request for one status match (`200`, `2xx`, `default`, ...), with an optional per-link mode. A request can have several links. |
| **Schema mode** | `off`, `warn`, or `strict`: what happens when a response does not match. |

Schemas contain **no sample values** unless you opt in to enums or bounds (see [Inference Options](#inference-options)).

---

## Creating a Schema

### Infer from the Last Response

1. Send the request and make sure the response body is JSON.
2. Open the **Schema** tab of the request.
3. Click **Infer from last response**.
4. In the editor that opens, review the name (it defaults to the request name plus the status code) and the JSON Schema, then click **Save**.

Saving an inferred schema also links it to the request for the status of the response you inferred from (for example `200`), unless that status already has a link.

The inferred schema follows the draft-07 dialect. The output is deterministic: the same input always produces the same schema, with properties sorted by name.

### Inference Options

The editor modal shows an **Infer from last response** strip when a response is available. It exposes three options and a **Re-infer** button that replaces the editor content with a new inference.

| Option | Default | Effect |
|---|---|---|
| **Formats** | On | Adds `format` (`uuid`, `email`, `uri`, `date`, `date-time`) to string fields where every sample matched the same format. |
| **Enums** | Off | Adds an `enum` for string fields that repeat a small set of short values (at most 8 distinct values of up to 40 characters, with at least one value seen twice). |
| **Bounds** | Off | Adds `minimum` / `maximum` for numbers, `minLength` / `maxLength` for strings (not when a `format` applies), and `minItems` / `maxItems` for arrays. |

Enums and bounds copy values seen in the response, which is why they are off by default. Keys that look volatile or secret never get an enum or bounds, and neither do their descendants. Volatile keys are ids, UUIDs, tokens, hashes, ETags, nonces, signatures, timestamps and dates (`id`, `userId`, `created_at`, `expiresAt`, ...). Secret-looking keys include `password`, `secret`, `token`, `api_key`, `authorization`, `cookie`, `session`, `jwt`, `otp`, `ssn`, `cvv`, and `iban`.

Two more options exist in the [HTTP API](#http-api) only, not in the editor:

| Option | Default | Effect |
|---|---|---|
| `additionalProperties` | unset | `false` adds `additionalProperties: false` to every object that has properties. |
| `requiredThreshold` | `1` | Fraction of samples (0 to 1) in which a key must appear to be listed in `required`. |

Inference from the UI uses a single sample (the last response). To infer one schema from several samples, call `POST /api/schemas/infer` with up to 50 samples.

### Write or Import a Schema

- **New schema** (in the request's Schema tab or **+ New schema** in the library) opens the editor with an empty object schema.
- **Import** in the library loads a schema file (see [Import and Export of Schema Files](#import-and-export-of-schema-files)).

The editor validates that the content is a JSON object and that the name is not empty, at most 100 characters, and unique. With a response available, **Test against last response** shows whether it matches and lists the violations.

If the schema uses JSON Schema 2019/2020 keywords that the validator does not support (`prefixItems`, `unevaluatedProperties`, `unevaluatedItems`, `dependentRequired`, `dependentSchemas`, `minContains`, `maxContains`, `$dynamicRef`, `$recursiveRef`), the editor shows a note listing them. These keywords are ignored during validation, so they do not constrain responses. See [Limits and Known Gaps](#limits-and-known-gaps).

### Reuse Other Schemas with `$ref`

A schema can reference another schema of the library **by name**:

```json
{
  "type": "object",
  "required": ["owner"],
  "properties": {
    "owner": { "$ref": "User" }
  }
}
```

The library shows which schemas reference the selected one. Renaming a schema does **not** rewrite `$ref`s or scripts that use the old name (the rename form warns you when it applies).

---

## Linking a Schema to a Request

Open the **Schema** tab of a request. The request must be saved in a collection to carry links.

1. Click **Add link**. A row appears with a status match, a schema picker, and a mode picker.
2. Enter the status match, pick the schema, and optionally pick a mode.
3. Remove a link with the trash button.

### Status Matching

| Match | Applies to |
|---|---|
| `200` (any status code from `100` to `599`) | Exactly that status |
| `4xx` (`1xx` to `5xx`) | Every status of that class |
| `default` | Every status without a more specific link |

For a response, Apilix picks the exact code first, then the class, then `default`. Matching is case-insensitive. A match that is not one of these forms is flagged in the row and not saved.

### Link Mode

| Link mode | Meaning |
|---|---|
| **Run mode** (default) | Use the mode of the run, see [The Schema Mode Ceiling](#the-schema-mode-ceiling). |
| **Off** | Never check this link. |
| **Warn** | Report violations without failing. |
| **Strict** | Fail the test on a violation (when the run allows it). |

---

## Checking a Response in the App

After you send a request, the response status bar shows a badge when a schema is linked to the response status:

- `Schema <name>: matches` (green)
- `Schema <name>: N violation(s)` (amber), with the first five violations in the tooltip
- `Schema <name>: invalid` (red) when the schema itself cannot be compiled

The badge is hidden when the response is an error or binary, or when the schema mode is `off` (in the Runner selector or on the link). Sending a single request never fails because of a schema: the badge is informational. Failing checks are a Runner and CLI concern.

---

## The Schema Library

Click **Schemas** in the Activity Bar. The left list shows each schema with its version, an **inferred** tag when it came from inference, and the number of requests that use it. Use **Search schemas** to filter by name or description.

Select a schema to see its details and use these actions:

| Action | Effect |
|---|---|
| **Edit** | Opens the editor modal. |
| **Rename** | Renames the schema. Names must be unique, ignoring case. Scripts using `matchSchema("<old name>")` and `$ref`s in other schemas are **not** updated. |
| **Duplicate** | Creates `<name> copy` (made unique if needed) at version 1 without history. |
| **Export** | Downloads this schema as a file. |
| **Delete** | Deletes the schema after a confirmation that lists the linked requests. All links to it are removed from every request. Scripts that call `matchSchema("<name>")` then fail with an unknown-schema error. |
| **+ New schema** | Opens the editor on an empty schema. |

The detail pane also shows **Used by** (each linked request with its status match and an **Open** button), the schemas that reference this one with `$ref`, the **Version history**, and the JSON Schema.

### Version History

Every change to the JSON Schema content increases the version number and pushes the previous content onto the history. Apilix keeps the **10** most recent previous versions. Changing only the name or description does not create a version.

In the library, **Restore as new version** next to a history entry makes that content the current schema as a new version. In the editor, **Load into editor** puts an old version in the text area without saving it.

### Import and Export of Schema Files

- **Export all** (and **Export** on one schema) writes a JSON file with `format: "apilix-response-schemas"`. The version history is not exported.
- **Import** accepts that file, a bare JSON array of schema entries, or a single plain JSON Schema (named after its `title`, or the file name).
- An imported schema whose id already exists in the library is skipped. When the name is already taken by a different schema, the imported one is renamed with a "(2)", "(3)", ... suffix and the `$ref`s inside the imported schemas are rewritten to the new name.

A notice at the top of the library reports how many schemas were imported, renamed, and skipped.

---

## Schema Checks in the Collection Runner

In the **Runner** panel, the **Response schemas (limit)** selector sets the schema mode of the run: **Off**, **Warn** (default), or **Strict**. The choice is remembered between sessions.

For each request that has a link matching its response status, the runner adds a synthetic test named `Schema: <status>` (for example `Schema: 200`) to the request's test results, tagged with a `schema` badge. Results in the panel look like this:

| Indicator | Meaning |
|---|---|
| `✓` | The response matches the schema. |
| `!` (amber) with the message | Violation in `warn` mode: the test counts as passing. |
| `✗` (red) with the message | Violation in `strict` mode: the test fails. |
| `~` | Skipped because the body was empty. |

The run summary shows a **Schema warnings** counter when at least one warning occurred.

### The Schema Mode Ceiling

The run-level mode is a **ceiling** over the per-link modes:

| Run mode | Link mode `off` | Link mode `warn` | Link mode `strict` | Link without mode |
|---|---|---|---|---|
| `off` | off | off | off | off |
| `warn` (default) | off | warn | warn (downgraded) | warn |
| `strict` | off | warn | strict | strict |

With the default `warn`, no schema violation can fail a run, even if a link is set to `strict`. Choose `strict` for the run when you want links set to `strict` (or without a mode) to fail it.

### What Counts as a Violation

| Situation | Result |
|---|---|
| Response body does not match the schema | Violation. The message lists up to five violations as `<json pointer> <message>`, plus a count of the rest. Messages never contain response values. |
| Response body is empty (for example `204`) | Skipped, passing (`empty body, nothing to validate`). Not a violation. |
| Response body is not valid JSON | Violation: `Response body is not valid JSON`. |
| Linked schema no longer exists | Violation: `Linked schema "<id>" was not found`. |
| Schema cannot be compiled | Violation: `Schema "<name>" is invalid: ...`. |
| Validation exceeds the [time limit](#validation-time-limit) | Violation. The schema is skipped for the rest of the run (it is reported as a violation on later requests without re-running). |
| Request failed (no HTTP status), or not an HTTP request | No schema test. |

In `warn` mode a violation is reported but passes. In `strict` mode it fails the test.

---

## Schema Checks in the CLI

`apilix run` performs the same checks as the Runner panel.

### Flags and Environment Variable

| Flag | Default | Description |
|---|---|---|
| `--schema-mode <off\|warn\|strict>` | `warn` | Run-level ceiling, see [The Schema Mode Ceiling](#the-schema-mode-ceiling). |
| `--schema-timeout <ms>` | `2000` | Time limit for one schema validation, `100` to `10000`. The `APILIX_SCHEMA_TIMEOUT_MS` environment variable sets the same value; the flag wins when both are present. |

An invalid `--schema-mode`, a non-numeric timeout, or a timeout outside `100` to `10000` ends the run immediately with exit code `2`.

```bash
# Fail the run when a strict link is violated
apilix run ./collection.json -e ./env.json --schema-mode strict

# Skip all schema checks
apilix run ./collection.json --schema-mode off

# Allow slower validations
APILIX_SCHEMA_TIMEOUT_MS=5000 apilix run ./collection.json --schema-mode strict
```

### Where the CLI Reads Schemas and Links

The CLI reads the collection file only; there is no separate schema file. It uses:

- `collection.apilix.schemas`: the array of schema entries (`id`, `name`, `schema`, ...)
- `request.apilix.schemaLinks` on each request: an array of `{ "schemaId", "match", "mode" }`

Both appear in a collection exported as Postman JSON from Apilix (see [Postman Import and Export](#postman-import-and-export)). The `$ref` registry for the run is built from the names in `apilix.schemas`.

```json
{
  "info": { "name": "Users API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "item": [
    {
      "name": "Get user",
      "request": {
        "method": "GET",
        "url": "{{baseUrl}}/users/1",
        "apilix": {
          "schemaLinks": [
            { "schemaId": "s-user", "match": "200" },
            { "schemaId": "s-error", "match": "4xx", "mode": "warn" }
          ]
        }
      }
    }
  ],
  "apilix": {
    "schemas": [
      { "id": "s-user", "name": "User", "version": 1,
        "schema": { "type": "object", "required": ["id"], "properties": { "id": { "type": "integer" } } } },
      { "id": "s-error", "name": "Error", "version": 1,
        "schema": { "type": "object", "required": ["message"] } }
    ]
  }
}
```

### Reporters and Exit Codes

| Reporter | How schema results appear |
|---|---|
| `table` | A violation in `strict` mode makes the request `FAIL`. A `warn` violation does not change the `PASS` status and is not printed in the table. |
| `json` | The test appears in the request's `testResults` as `Schema: <status>` with `synthetic: true`. Warnings carry `schemaSeverity: "warn"` and an `error` message while `passed` stays `true`; strict violations have `schemaSeverity: "fail"` and `passed: false`; empty bodies have `skipped: true`. `summary.schemaWarnings` counts the warnings, and `summary.synthetic` counts generated tests. |
| `junit` | A test case named `[test] <request> :: Schema: <status>`. Strict violations are `<failure>` elements, an empty body is `<skipped/>`, and a warning is a passing case with `[schema warning] <message>` in `<system-out>`. |

In every mode the completion line on standard error ends with the warning count when there is one, for example `Run complete: 12 requests, 30 passed, 0 failed, 0 request errors, 2 schema warnings.`

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Success. Schema warnings alone do not change the exit code. |
| `1` | At least one failed test (including `strict` schema violations) or request error. |
| `2` | Invalid usage or input, including an invalid `--schema-mode` or schema timeout. |

### Standalone Binary Caveat

When the time limit is enforced, validation runs in a worker thread that is terminated on overrun. The standalone CLI binary (built with `pkg`) cannot load worker threads, so there it runs without a real time limit. To limit the risk, the binary applies a static check that rejects regular expressions (`pattern`, `patternProperties`) prone to catastrophic backtracking, and the check is conservative. A schema rejected this way produces a violation (`Schema "<name>" could not be checked: ...`). The binary prints this warning once on standard error when schema checks are not `off`:

```text
Warning: Schema validation time limit is not enforced in this runtime (worker threads are unavailable); patterns prone to catastrophic backtracking are skipped instead.
```

Running the CLI from source with Node.js (`npm run cli`) enforces the time limit.

---

## Validation Time Limit

A `pattern` keyword with a badly written regular expression can take forever to evaluate. Apilix therefore time-boxes each validation:

- **App:** **Settings** > **Requests** > **Defaults** > **Schema validation time limit (ms)**. Range `100` to `10000`, default `2000`. Values outside the range are clamped. The value is sent to the local server with the other request settings.
- **CLI:** `--schema-timeout` or `APILIX_SCHEMA_TIMEOUT_MS`, same range (out of range is an error).

When a validation overruns, the check reports a timeout violation instead of hanging. Note that validation is synchronous: while it runs, the server thread waits for the result, for up to the time limit.

---

## Scripting: `matchSchema()`

`apx.expect(value).to.matchSchema(schemaOrName)` accepts either a JSON Schema object or the **name** of a library schema. The `pm.expect` alias works the same way. See [Scripting](Scripting#json-schema-validation) for the assertion chain.

```js
apx.test("User matches the User schema", () => {
  apx.expect(apx.response.json()).to.matchSchema("User");
});

apx.test("Error body is not a User", () => {
  apx.expect(apx.response.json()).to.not.matchSchema("User");
});
```

| Form | Behavior |
|---|---|
| `.matchSchema("User")` | Validates against the library schema named `User`, resolving `$ref`s by name. The name is case-sensitive. |
| `.matchSchema({ ... })` | Validates against an inline schema. Named `$ref`s resolve against the library. |
| `.not.matchSchema(...)` | Passes when the value does **not** match. |

Behavior to know:

- The failure message shows the first violation with its path, for example `Expected value to match schema: /email must match format "email"`.
- An unknown name throws an error that lists the available names: `matchSchema: unknown schema "Usr". Available schemas: Error, User`. With an empty library it reads `No response schemas are defined for this collection.` Inside `apx.test()` the error fails that test.
- A schema that cannot be compiled, a validation that times out, and (in the standalone CLI binary) a regular expression rejected by the static check throw errors starting with `matchSchema:`.
- Named schemas are **not available** in child requests run through `apx.executeRequest()`: the child's scripts do not receive the library, so `matchSchema("Name")` throws an unknown-schema error there. Inline schema objects still work. Schema links are also not checked on child requests.
- Schemas reach scripts from the workspace library when you send a request or start a run in the app, and from `collection.apilix.schemas` in the CLI.

---

## Postman Import and Export

Apilix stores its schema data in `apilix` extension fields that Postman ignores:

- `request.apilix.schemaLinks` on each request
- `apilix.schemas` at the top level of the collection

**Export.** **Export** > **Postman JSON** writes `apilix.schemas` with every schema linked from the collection's requests, plus the schemas those schemas reference by name with `$ref` (transitively). Schemas not used by the collection are not written. When no schema is used, no `apilix` block is added. The request links are part of the exported requests.

**Import.** Importing a collection that contains `apilix.schemas` moves the schemas into the workspace library (the collection itself keeps no copy) and merges them with these rules:

| Situation | Result |
|---|---|
| A schema with the same `id` already exists | The incoming schema is skipped; the existing one is kept. |
| A different schema already uses the name | The incoming schema is renamed (suffix "(2)", "(3)", ...) and `$ref`s inside the imported schemas are rewritten to the new name. |
| Otherwise | The schema is added. |

A notification reports how many schemas were renamed and skipped. Request links keep working because they refer to the schema `id`.

---

## Sync Conflicts

Schemas are part of the workspace data, so they sync with it. The three-way merge treats each schema separately, by id:

- A side that changed a schema wins over a side that left it alone.
- When both sides changed the same schema differently, or one side deleted it while the other edited it, a conflict appears under **Response Schemas** in the merge modal. You pick **Take Local** or **Take Remote** like for any other conflict. Until you resolve it, the merged data keeps the local side.
- Only the name, description, and JSON Schema count as changes. Version numbers, timestamps, and history alone do not create a conflict.
- Names stay unique after a merge; duplicates get a "(2)", "(3)" suffix.
- A remote workspace saved by an older version without schemas is treated as "no change", not as "everything deleted".

See [Sync & Collaboration](Sync-and-Collaboration#three-way-merge-modal) for the merge modal.

---

## HTTP API

The local Apilix server exposes the schema engine. All routes are on the server base URL (`http://localhost:3001` in web mode).

### `POST /api/schemas/infer`

Infer a schema from samples.

```json
{
  "samples": [{ "id": 1, "name": "Ada" }, { "id": 2, "name": "Linus" }],
  "options": { "formats": true, "requiredThreshold": 1 }
}
```

| Field | Description |
|---|---|
| `samples` | Non-empty array (at most 50) of parsed JSON values. |
| `bodies` | Alternative to `samples`: non-empty array (at most 50) of JSON strings, each at most 1,000,000 characters. |
| `options` | Optional: `requiredThreshold` (0 to 1), `enums`, `bounds`, `formats`, `additionalProperties` (booleans), `maxDepth` (integer 1 to 20), `maxArrayItems` (integer 1 to 1000). |

Returns `{ "schema": { ... } }`. Without `samples` or `bodies`, or with invalid values, it returns `400` with `{ "error": "..." }`.

### `POST /api/schemas/validate`

Validate data against a schema.

```json
{
  "schema": { "$ref": "User" },
  "body": "{\"id\":1}",
  "schemas": [{ "name": "User", "schema": { "type": "object", "required": ["id"] } }],
  "allErrors": true
}
```

| Field | Description |
|---|---|
| `schema` | Required schema object. |
| `data` or `body` | The value to validate: parsed (`data`) or as a JSON string (`body`, at most 1,000,000 characters). One of them is required. |
| `schemas` | Optional registry for `$ref` by name: at most 200 entries of `{ name, schema }`, name at most 200 characters. |
| `allErrors` | Optional boolean, default `true`. |

Returns `{ "valid": true, "errors": [] }` or `{ "valid": false, "errors": [{ "path", "keyword", "message" }] }`. At most 50 errors are returned (`truncated: true` when there were more). Messages never include data values. A `body` that is not valid JSON returns `valid: false` with a `parse` error (HTTP 200). A schema that cannot be compiled returns `schemaError`; a validation that exceeds the time limit returns `timedOut: true` with a `timeout` error; both with HTTP 200.

Both routes accept a JSON body of up to 2 MB (`413` above that, `400` for malformed JSON).

### Other routes that use schemas

| Route | Schema-related fields |
|---|---|
| `POST /api/execute` | `schemas`: array of `{ name, schema }` (extra fields are ignored) so scripts can call `matchSchema("Name")`. |
| `POST /api/run` | In the `data` JSON: `schemaMode` (`off`, `warn`, `strict`; other values return `400`), `schemas` (array of schema entries with `id`, `name`, `schema`), and `links` (object keyed by request id with an array of links, which takes precedence over the links stored on the request). |
| `POST /api/settings` | `schemas.validationTimeoutMs` sets the validation time limit (clamped to 100 to 10000 ms). |

---

## Limits and Known Gaps

- **JSON only.** XML responses and database results are not validated yet; they are planned for a later version.
- **Dialect.** The validator is Ajv in non-strict mode with draft-07 behavior plus the standard formats. JSON Schema 2019/2020 keywords it does not know are ignored without error (the editor shows a note). A root `$schema` URI is dropped before validation.
- **Renaming.** Renaming a schema does not rewrite scripts that call `matchSchema("<name>")` or `$ref`s in other schemas.
- **Blocking validation.** Validation is synchronous and blocks the server thread for up to the [time limit](#validation-time-limit).
- **Standalone binary.** No real time limit in the `pkg` binary, see [Standalone Binary Caveat](#standalone-binary-caveat).
- **Child requests.** Named schemas and link checks do not apply to requests run with `apx.executeRequest()`.
- **Single sample in the UI.** Inference from the app uses the last response; multi-sample inference and the `requiredThreshold` / `additionalProperties` options are available through the HTTP API.

---

## See Also

- [Scripting](Scripting#json-schema-validation) — the `apx.expect()` assertion chain, including `matchSchema()`
- [Collection Runner](Collection-Runner) — run options, CLI flags, and exit codes
- [Import & Export](Import-and-Export) — Postman JSON export with schemas
- [Sync & Collaboration](Sync-and-Collaboration) — three-way merge and conflict resolution
- [Settings & Configuration](Settings-and-Configuration) — the schema validation time limit
