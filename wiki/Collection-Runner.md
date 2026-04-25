# Collection Runner

The Collection Runner executes multiple requests from a collection in sequence, repeating them across iterations, optionally driven by a CSV data file. It is the primary tool for automated testing, data-driven API validation, and scripted workflow execution.

---

## Table of Contents

- [Collection Runner](#collection-runner)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Run Collections from the CLI](#run-collections-from-the-cli)
    - [Before You Start](#before-you-start)
    - [Basic Workflow](#basic-workflow)
    - [Reporter Output](#reporter-output)
    - [CLI Examples](#cli-examples)
    - [Standalone Binary Examples](#standalone-binary-examples)
    - [CLI Flags Reference](#cli-flags-reference)
    - [Exit Codes](#exit-codes)
  - [Opening the Runner](#opening-the-runner)
  - [Selecting Requests](#selecting-requests)
    - [Reordering Requests](#reordering-requests)
  - [Configuring the Run](#configuring-the-run)
    - [Iterations](#iterations)
    - [Delay](#delay)
    - [Conditional Execution](#conditional-execution)
    - [Execute Child Requests](#execute-child-requests)
    - [Mock Server Mode](#mock-server-mode)
  - [Data-driven Runs with CSV](#data-driven-runs-with-csv)
    - [CSV Format](#csv-format)
    - [Accessing Data in Scripts](#accessing-data-in-scripts)
  - [Running, Pausing, and Stopping](#running-pausing-and-stopping)
  - [Live Results](#live-results)
    - [Iteration Blocks](#iteration-blocks)
    - [Request Rows](#request-rows)
    - [Test Results](#test-results)
    - [Child Requests](#child-requests)
    - [setNextRequest Jump Indicators](#setnextrequest-jump-indicators)
  - [Performance Metrics](#performance-metrics)
    - [Statistics](#statistics)
    - [Bar Chart](#bar-chart)
  - [Execution Control from Scripts](#execution-control-from-scripts)
    - [Skip a Request](#skip-a-request)
    - [Jump to a Named Request](#jump-to-a-named-request)
    - [Stop the Run](#stop-the-run)
    - [Jump by Request ID](#jump-by-request-id)
  - [Run History and Saved Runs](#run-history-and-saved-runs)
    - [Automatic Recent Runs](#automatic-recent-runs)
    - [Saving a Run Manually](#saving-a-run-manually)
    - [Browsing Runs in the Sidebar](#browsing-runs-in-the-sidebar)
    - [Loading a Past Run](#loading-a-past-run)
    - [Persistence and Limits](#persistence-and-limits)
  - [Common Patterns](#common-patterns)
    - [Pattern 1 — Login Once, Use Token Everywhere](#pattern-1--login-once-use-token-everywhere)
    - [Pattern 2 — Data-driven CRUD Test](#pattern-2--data-driven-crud-test)
    - [Pattern 3 — Polling Loop](#pattern-3--polling-loop)
    - [Pattern 4 — Stop on First Failure](#pattern-4--stop-on-first-failure)
  - [See Also](#see-also)

---

## Overview

The Runner executes requests in the order you choose, one at a time, running pre-request and test scripts for each. Results stream in live as each request completes.

Key capabilities:

| Capability | Description |
|---|---|
| **Multi-iteration** | Run the same set of requests N times |
| **CSV-driven** | Each CSV row becomes one iteration, with row data available as `apx.iterationData` |
| **Conditional flow** | Scripts can jump to a named request or stop the run early via `apx.execution.setNextRequest()` |
| **Performance metrics** | Min/avg/max/P50/P95/P99 response time statistics with a live bar chart |
| **Live streaming** | Results appear as each request completes — no waiting for the full run |
| **Child requests** | Requests triggered by `apx.executeRequest()` inside scripts are shown nested under their parent |

![Collection Runner overview](images/runner-overview.png)

## Run Collections from the CLI

The same runner engine is also available from the command line for CI jobs, scheduled checks, and headless local validation. Use the CLI when you want Apilix to execute a collection, apply environments and CSV data, and emit machine-readable JSON or JUnit reports without opening the UI.

Preferred syntax uses a positional collection file path (`apilix run ./collection.json`). For backward compatibility with older scripts, `--collection ./collection.json` is still supported.

### Before You Start

- Export or save the collection you want to run as a Postman/Apilix collection JSON file.
- Export the environment, globals, or collection variables you want to apply as JSON files when needed.
- If you want data-driven iterations, prepare a CSV file with a header row.

### Basic Workflow

1. Open a terminal in your Apilix project checkout.
2. Run the CLI with the `run` command and pass a collection file.
3. Optionally add `-e/--environment`, `--globals`, `--collection-vars`, or `--csv`.
4. Choose a reporter: `table`, `json`, `junit`, or `both`.
5. Write the report to terminal, standard output, a single file, or an output directory.

Basic example:

```bash
npm run cli -- run \
  ./collection.json \
  -e ./environment.json
```

Legacy-compatible syntax (still supported):

```bash
npm run cli -- run \
  --collection ./collection.json \
  --environment ./environment.json
```

By default, the CLI writes a terminal summary table and prints a short completion summary to standard error.

### Reporter Output

| Reporter | Output | Best for |
|---|---|---|
| `table` | Newman-like request table (request, status, time, assertions) | Quick local runs and troubleshooting |
| `json` | Apilix run report with summary, config, iterations, request results, and errors | Local debugging, custom scripts, artifact storage |
| `junit` | JUnit XML with request, test, child-request, and run-error cases | CI systems that ingest test reports |
| `both` | Writes both formats together | Pipelines that want machine-readable artifacts plus test dashboards |

Output rules:

- `--reporter table` prints to terminal only.
- `--reporter json` writes JSON to standard output unless `--out` or `--out-dir` is set.
- `--reporter junit` writes JUnit XML to standard output unless `--out` or `--out-dir` is set.
- `--reporter both` requires `--out-dir` and writes `apilix-run.json` plus `apilix-run.junit.xml`.
- Invalid collection files, unreadable files, malformed JSON, and malformed CSV input fail immediately with exit code `2`.

### CLI Examples

Run a collection once and print JSON to the terminal:

```bash
npm run cli -- run \
  ./collection.json \
  -e ./environment.json \
  --reporter json
```

Write a JUnit report for CI test publishing:

```bash
npm run cli -- run \
  ./collection.json \
  -e ./environment.json \
  --reporter junit \
  --out ./artifacts/apilix.junit.xml
```

Run one iteration per CSV row and publish both report formats:

```bash
npm run cli -- run \
  ./collection.json \
  -e ./environment.json \
  --csv ./users.csv \
  --reporter both \
  --out-dir ./artifacts
```

Enable child requests and keep `setNextRequest()` flow control active:

```bash
npm run cli -- run \
  ./workflow.json \
  -e ./environment.json \
  --execute-child-requests \
  --reporter json \
  --out ./artifacts/workflow.json
```

Disable conditional jumps and force straight-line execution order:

```bash
npm run cli -- run \
  ./workflow.json \
  --no-conditional-execution \
  --reporter json
```

Adjust network behavior for CI:

```bash
npm run cli -- run \
  ./collection.json \
  --timeout 10000 \
  --ssl-verification \
  --no-follow-redirects \
  --reporter json
```

Disable ANSI colors for plain CI logs:

```bash
npm run cli -- run \
  ./collection.json \
  --no-color
```

Build standalone CLI binaries (macOS/Linux/Windows):

```bash
npm run cli:build:binaries
```

### Standalone Binary Examples

After building binaries, run Apilix directly without `npm run`.

macOS:

```bash
./dist/cli/apilix-macos run ./collection.json -e ./environment.json
```

Linux:

```bash
./dist/cli/apilix-linux run ./collection.json -e ./environment.json --reporter json
```

Windows (PowerShell):

```powershell
.\dist\cli\apilix-win.exe run .\collection.json -e .\environment.json --reporter both --out-dir .\artifacts
```

If you rename one binary to `apilix` and put it on your `PATH`, you can use shorter commands:

```bash
apilix run ./collection.json --reporter table
apilix run ./collection.json --reporter junit --out ./artifacts/apilix.junit.xml
```

> **Tips**
>
> - Use `--csv` when each data row should become a separate iteration; `--iterations` is only used when no CSV file is supplied.
> - Use `--reporter both --out-dir ...` when your CI system needs JUnit for test dashboards and JSON for later analysis.
> - If the CLI reports an invalid CSV error, fix the file before retrying — Apilix stops before the run begins rather than silently falling back to iteration-only mode.

### CLI Flags Reference

| Flag | Short | Description |
|---|---|---|
| `./collection.json` (positional) | | Collection JSON file path — preferred syntax |
| `--collection <path>` | | Legacy alternative to the positional argument |
| `--environment <path>` | `-e` | Environment JSON file to apply |
| `--globals <path>` | | Globals JSON file to apply |
| `--collection-vars <path>` | | Collection variables JSON file to apply |
| `--csv <path>` | | CSV file for data-driven iterations (one row = one iteration) |
| `--iterations <n>` | | Number of iterations when no CSV is supplied (default: `1`) |
| `--reporter <type>` | | Output format: `table` (default), `json`, `junit`, or `both` |
| `--out <path>` | | Write `json` or `junit` output to this file instead of stdout |
| `--out-dir <path>` | | Write both report files here (required for `--reporter both`) |
| `--timeout <ms>` | | Per-request timeout in milliseconds (default: `30000`) |
| `--execute-child-requests` | | Execute HTTP calls made inside scripts via `apx.executeRequest()` |
| `--no-conditional-execution` | | Ignore `setNextRequest()` calls; run requests in listed order |
| `--ssl-verification` | | Enforce TLS certificate verification (disabled by default) |
| `--no-follow-redirects` | | Return redirect responses instead of following them automatically |
| `--no-color` | | Disable ANSI colour sequences — useful for plain CI logs |

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | Successful run — no failed assertions and no request errors |
| `1` | One or more failed assertions, request errors, or runner flow errors |
| `2` | Invalid CLI usage or unreadable / invalid input file (collection, environment, CSV) |

---

## Opening the Runner

Click the **Runner** icon in the Activity Bar (left sidebar) to open the Runner panel. The panel slides in from the right and overlays the main interface.

You can also right-click any collection or folder in the Collection Tree and choose **Execute in Runner** to open the Runner pre-configured with that collection (or folder) and all its requests selected.

![Runner panel — configuration view](images/runner-config.png)

---

## Selecting Requests

The **Request Selection Tree** mirrors the collection's folder structure. Each request has a checkbox; folders have an aggregate checkbox with an indeterminate state when partially selected.

![Request selection tree](images/runner-selection-tree.png)

| Control | Action |
|---|---|
| **Collection dropdown** | Switch which collection to run |
| **Folder checkbox** | Select or deselect all requests inside the folder |
| **Request checkbox** | Toggle a single request |
| **Select All** | Check every request in the collection |
| **Deselect All** | Uncheck all requests |
| Request count badge | e.g. `(3/5)` — selected / total in folder |

**Request badges** shown in the tree:

| Badge | Meaning |
|---|---|
| `next` (amber) | This request's script calls `setNextRequest()` — it will influence execution order |
| `child` (violet) | This request's script calls `apx.executeRequest()` — it spawns child requests at run time |

### Reordering Requests

The **Execution Order** list below the selection tree shows the selected requests in run order. Drag any row up or down to change the order. The execution order is independent of the folder hierarchy — you can interleave requests from different folders.

![Execution order drag-and-drop](images/runner-execution-order.png)

---

## Configuring the Run

### Iterations

Set the number of times the full request sequence runs. Each pass is one **iteration**. Results are grouped by iteration number in the results panel.

> When a CSV file is uploaded, the iteration count is ignored — the runner runs one iteration per CSV data row instead.

### Delay

Set an inter-request delay in milliseconds. A non-zero delay inserts a pause between each request. Useful for rate-limited APIs or simulating realistic user pacing.

### Conditional Execution

When **Conditional Execution** is enabled (default: on), the runner resolves `setNextRequest()` chains before the run begins. If a selected request's script statically references a `setNextRequest('Target Name')` call, the named target is automatically appended to the execution chain after that request — even if it wasn't manually selected.

Auto-added requests are shown in an **Execution Preview** panel below the configuration. Requests shown in this panel that were not manually selected are labelled *auto-added*.

When disabled, every request executes in the listed order regardless of any `setNextRequest()` calls in scripts. The calls are still executed at runtime but have no effect on ordering.

### Execute Child Requests

When enabled, the runner also executes HTTP requests triggered inside scripts via `apx.executeRequest()`. These appear as **child rows** nested under their parent request in the results panel, tagged `pre` (triggered in a pre-request script) or `test` (triggered in a test script).

### Mock Server Mode

When the Mock Server is running and **Run in Mock Server** is enabled, all requests in the run are routed through the mock server's base URL. Useful for testing your collection against mock responses without hitting a live backend.

See [Mock Server](Mock-Server) for how to define routes and start the server.

---

## Data-driven Runs with CSV

Upload a CSV file to drive iterations with real data. Each row after the header becomes one iteration.

![CSV upload and preview](images/runner-csv-upload.png)

### CSV Format

```csv
username,password,expectedRole
alice,secret1,admin
bob,secret2,user
carol,secret3,viewer
```

- The **first row** is the header row — column names become variable keys.
- Each **subsequent row** is one iteration. The runner runs as many iterations as there are data rows.
- Values are always strings. Convert in scripts when needed (e.g. `Number(apx.iterationData.get('count'))`).
- A **preview table** (first 5 rows) is shown after upload.

### Accessing Data in Scripts

Use `apx.iterationData` to read the current row's values. It is read-only (`.get()` and `.has()` only).

```js
// Pre-request script — inject CSV values into the request body
const username = apx.iterationData.get('username');
const password = apx.iterationData.get('password');

// Store as environment variables for use in {{variable}} placeholders
apx.environment.set('username', username);
apx.environment.set('password', password);
```

```js
// Test script — validate against expected CSV value
apx.test("Role matches expected", () => {
  const expected = apx.iterationData.get('expectedRole');
  apx.expect(apx.response.json().role).to.equal(expected);
});
```

The current row's values are also shown in the **Iteration Block header** during the run (e.g. `username=alice | expectedRole=admin`).

---

## Running, Pausing, and Stopping

| Control | Action |
|---|---|
| **Run** | Start the run. The configuration panel collapses and the results panel appears. |
| **Pause** | Pause after the current request completes. The run waits until resumed. |
| **Resume** | Continue from where it was paused. |
| **Stop** | Cancel the run immediately after the current request. Partial results are preserved. |

While a run is in progress, the configuration panel is hidden. Click the **⚙ Configure** toggle to reveal it without stopping the run.

---

## Live Results

Results stream in as each request completes. The results panel is divided into collapsible **Iteration Blocks**.

![Runner results panel — live](images/runner-results-live.png)

### Iteration Blocks

Each iteration is a collapsible block with a summary badge:

| Badge colour | Meaning |
|---|---|
| Red | One or more network errors in this iteration |
| Yellow | Some tests failed |
| Green | All tests passed |
| Grey | No tests defined — shows request count instead |

The header also shows data row values when a CSV file was used (e.g. `username=alice | expectedRole=admin`).

### Request Rows

Each request row shows:

| Column | Description |
|---|---|
| **Status** | HTTP status code, colour-coded (green = 2xx, yellow = 4xx, red = 5xx, `ERR` if network error) |
| **Method** | HTTP method |
| **Name** | Request name |
| **Response time** | Time in ms |
| **Test badge** | `passed/total` count — green if all passed, red if any failed |

Click a row to expand it and see individual test results.

### Test Results

Each test result shows:

| Indicator | Meaning |
|---|---|
| `✓` green | Test passed |
| `✗` red | Test failed — error message shown inline |
| `~` grey italic | Test skipped via `apx.test.skip()` |

### Child Requests

If **Execute Child Requests** is enabled and a script calls `apx.executeRequest()`, child requests appear nested under the parent with a tree connector. Each child row shows:

- Status, method, name, response time
- A tag badge: `pre` (blue) for requests fired from a pre-request script, `test` (purple) for requests fired from a test script
- Expandable test results

### setNextRequest Jump Indicators

When a request's script calls `apx.execution.setNextRequest('Target')`, a jump indicator is shown immediately after that request row:

```
↪  setNextRequest  →  Target Name
```

This makes the execution flow easy to trace visually, even in complex branching scenarios.

---

## Performance Metrics

After a run completes (or while it is still running), the **⚡ Performance Metrics** panel appears below the iteration blocks.

![Performance metrics panel](images/runner-performance-metrics.png)

### Statistics

| Stat | Description |
|---|---|
| **Min** | Fastest request in the run |
| **Avg** | Mean response time across all successful requests |
| **Max** | Slowest request in the run |
| **P50** | Median response time |
| **P95** | 95th percentile — 95% of requests were faster than this |
| **P99** | 99th percentile — 99% of requests were faster than this |

> Failed requests (network errors) are excluded from performance metrics. Child requests are included and shown in a distinct colour.

### Bar Chart

A bar chart plots the response time of every request in run order. Bar colour indicates speed:

**Parent requests:**
- Green — < 200 ms
- Orange — 200–800 ms
- Red — > 800 ms

**Child requests** (triggered by `apx.executeRequest()`):
- Cyan — < 200 ms
- Purple — 200–800 ms
- Pink — > 800 ms

Hover a bar to see the tooltip: `Request Name (METHOD): 123ms`.

---

## Execution Control from Scripts

Scripts can control the runner's flow dynamically. These calls are no-ops when a request is sent individually (outside the runner).

### Skip a Request

Call `apx.execution.skipRequest()` in a **pre-request script** to skip the HTTP request entirely. The request is still listed in the results but no HTTP call is made.

```js
// Pre-request script — skip if a required variable is missing
const userId = apx.environment.get('userId');
if (!userId) {
  console.warn('userId not set — skipping request');
  apx.execution.skipRequest();
}
```

### Jump to a Named Request

Call `apx.execution.setNextRequest(name)` in a **test script** to jump to a different request next, instead of proceeding sequentially.

```js
// Test script — loop back to a polling endpoint until job is done
const json = apx.response.json();
if (json.status === 'processing') {
  // Keep polling — come back to this same request
  apx.execution.setNextRequest('Poll Job Status');
} else {
  // Job done — proceed to the next step
  apx.execution.setNextRequest('GET /jobs/:id/result');
}
```

### Stop the Run

Pass `null` to stop the runner after the current request. No further requests or iterations execute.

```js
// Test script — abort the run on auth failure
apx.test("Auth check", () => {
  if (apx.response.code === 401) {
    console.error('Unexpected 401 — stopping run');
    apx.execution.setNextRequest(null);
  }
  apx.response.to.have.status(200);
});
```

### Jump by Request ID

For collections where multiple requests share the same name, use the ID-based variant. IDs are stable even if request names change.

```js
apx.execution.setNextRequestById('a1b2c3d4-...');
```

---

## Run History and Saved Runs

Apilix automatically tracks the last 5 completed runs per workspace and lets you save any run under a custom name for later review or re-execution.

### Automatic Recent Runs

Every run that completes or is stopped is automatically added to the **Recent** list in the Runner Runs sidebar. Up to 5 runs are kept; once the limit is reached the oldest entry is replaced.

Recent runs are saved without any manual action on your part — they are there the moment the run finishes.

### Saving a Run Manually

To preserve a run beyond the 5-entry rolling limit, save it with a custom name:

1. After a run completes (or is stopped), click the **Save Run** button that appears in the top-right corner of the results panel.
2. Type a name in the **Save Run** dialog (e.g. `Baseline v1.2 — staging`).
3. Press **Enter** or click **Save**.

The run is added to the **Saved** section of the Runner Runs sidebar and persists indefinitely until you delete it.

> **Tip:** The name field is pre-filled with the auto-generated label (`Collection Name — HH:MM:SS`) so you can see what you're naming before committing.

### Browsing Runs in the Sidebar

Click the **▶ Runner** icon in the Activity Bar to open the Runner panel. When runs exist, the sidebar shows two sections:

| Section | Contents |
|---|---|
| **Recent** | Up to 5 auto-saved runs, newest first. A **(N/5)** badge shows how full the buffer is. Click **Clear** to remove all recent entries. |
| **Saved** | All manually saved runs, newest first. Each row has a delete button (hover to reveal). |

Each run row shows:

| Element | Description |
|---|---|
| **Name** | Custom name (saved runs) or auto-generated label (recent runs) |
| **Collection name** | The collection the run was executed against |
| **Relative time** | e.g. `3m ago`, `2h ago`, `1d ago` |
| **Summary badge** | Total requests, passing tests (✓), failing tests (✗), and network errors (!). Badge is green when all tests pass, yellow when some fail, red when there are errors. |

### Loading a Past Run

Click any run row in the sidebar to load it into the Runner panel:

1. The Runner panel opens (or comes into focus).
2. The configuration is restored to match the original run: collection, selected requests, execution order, iterations, delay, and advanced settings.
3. The original results are displayed in the results panel.
4. A **Viewing saved run** notice appears at the top of the results panel as a reminder that you are looking at historical data.

From this state you can:

- **Analyse the results** as-is.
- **Click Run** to re-execute with the same configuration. The notice disappears and new live results replace the historical ones. The new run is automatically added to Recent.
- **Modify any config** before re-running (e.g. change the iteration count or target environment).
- **Dismiss the notice** by clicking **×** without triggering a run.

### Persistence and Limits

| Detail | Value |
|---|---|
| Recent run buffer | 5 runs per workspace (oldest dropped automatically) |
| Saved run limit | Unlimited — delete manually when no longer needed |
| Persistence debounce | 500 ms after each change |
| Workspace isolation | Each workspace has its own independent run history |

**Storage locations:**

| Mode | File |
|---|---|
| Desktop (Electron) | `<userData>/workspaces/<workspaceId>/runner-recent.json` and `runner-saved.json` |
| Browser / Web mode | `localStorage` keys `apilix_runner_recent_<workspaceId>` and `apilix_runner_saved_<workspaceId>` |

Workspace transitions (create, switch, duplicate) reset both recent and saved run lists in memory. The files for the previous workspace are preserved on disk and reloaded if you switch back.

---

## Common Patterns

### Pattern 1 — Login Once, Use Token Everywhere

Place a login request first. Its test script captures the token. All subsequent requests inherit it via `{{accessToken}}`.

**POST /auth/login — test script:**
```js
const json = apx.response.json();
apx.environment.set('accessToken', json.token);
apx.environment.set('userId', String(json.user.id));
```

All other requests use `Bearer {{accessToken}}` in their Auth tab (set to **Inherit** from collection, which has Bearer `{{accessToken}}`).

---

### Pattern 2 — Data-driven CRUD Test

Use a CSV to create, update, and delete resources with different data for each iteration.

**CSV (`users.csv`):**
```csv
name,email,role
Alice,alice@example.com,admin
Bob,bob@example.com,user
```

**POST /users — test script:**
```js
// Store the created user's ID for subsequent requests in this iteration
const json = apx.response.json();
apx.environment.set('createdUserId', String(json.id));
```

**GET /users/:id — uses `{{createdUserId}}`**

**DELETE /users/:id — uses `{{createdUserId}}`**

Each CSV row runs through all three requests independently.

---

### Pattern 3 — Polling Loop

Use `setNextRequest()` to keep polling until a condition is met, then continue.

**POST /jobs — test script:**
```js
const json = apx.response.json();
apx.environment.set('jobId', json.id);
```

**GET /jobs/:id — test script:**
```js
const json = apx.response.json();
if (json.status === 'processing') {
  // Check again on the next iteration cycle
  apx.execution.setNextRequest('GET /jobs/:id');
} else if (json.status === 'failed') {
  console.error('Job failed:', json.error);
  apx.execution.setNextRequest(null);
} else {
  // Completed — proceed to fetch results
  apx.execution.setNextRequest('GET /jobs/:id/result');
}
```

> Set a **Delay** of 1000 ms or more to avoid hammering the polling endpoint.

---

### Pattern 4 — Stop on First Failure

Stop the entire run as soon as a critical request fails, to avoid cascading errors with a broken auth token or missing resource.

```js
// Test script on POST /auth/login
apx.test("Login OK", () => {
  apx.response.to.have.status(200);
});

if (apx.response.code !== 200) {
  console.error('Login failed — stopping run');
  apx.execution.setNextRequest(null);
}
```

---

## See Also

- [Scripting](Scripting) — full `apx.execution.*` and `apx.iterationData` API reference
- [Variables & Environments](Variables-and-Environments) — scope hierarchy and data row variables
- [Mock Server](Mock-Server) — run the collection against mock responses
- [Collections & Requests](Collections-and-Requests) — managing collections and request scripts
