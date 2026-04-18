# Mock Server

The Apilix Mock Server lets you define HTTP and WebSocket endpoints that return controlled responses without a real backend. Use it to develop against a contract before the API exists, test edge cases and error scenarios that are hard to trigger in a live system, and run your collection in isolation.

---

## Table of Contents

- [Mock Server](#mock-server)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Opening the Mock Server](#opening-the-mock-server)
  - [Starting and Stopping the Server](#starting-and-stopping-the-server)
  - [Route Collections](#route-collections)
  - [Managing Routes](#managing-routes)
    - [Route List Columns](#route-list-columns)
    - [Adding a Route](#adding-a-route)
    - [Editing a Route](#editing-a-route)
    - [Enabling and Disabling Routes](#enabling-and-disabling-routes)
    - [Deleting a Route](#deleting-a-route)
  - [HTTP Route Configuration](#http-route-configuration)
    - [Method and Path](#method-and-path)
    - [Status Code and Delay](#status-code-and-delay)
    - [Response Headers](#response-headers)
    - [Response Body and Template Variables](#response-body-and-template-variables)
  - [Conditional Rules](#conditional-rules)
    - [Rule Sources](#rule-sources)
    - [Rule Operators](#rule-operators)
    - [Rule Response](#rule-response)
    - [Rule Evaluation Order](#rule-evaluation-order)
  - [Response Scripts](#response-scripts)
    - [The `req` Object](#the-req-object)
    - [The `respond()` Function](#the-respond-function)
    - [Persistent State — `db.*`](#persistent-state--db)
    - [Priority Order](#priority-order)
  - [WebSocket Routes](#websocket-routes)
    - [On-Connect Events](#on-connect-events)
    - [Message Handlers](#message-handlers)
  - [Importing Routes](#importing-routes)
    - [Import from Collection](#import-from-collection)
    - [Import from HAR File](#import-from-har-file)
  - [Traffic Inspector](#traffic-inspector)
  - [Persistent State Database](#persistent-state-database)
  - [Using the Mock Server with the Collection Runner](#using-the-mock-server-with-the-collection-runner)
  - [Common Patterns](#common-patterns)
    - [Pattern 1 — Static Stub (Simplest)](#pattern-1--static-stub-simplest)
    - [Pattern 2 — Simulate Auth Failure](#pattern-2--simulate-auth-failure)
    - [Pattern 3 — Dynamic Response with Path Param](#pattern-3--dynamic-response-with-path-param)
    - [Pattern 4 — In-memory CRUD API](#pattern-4--in-memory-crud-api)
    - [Pattern 5 — Simulate Latency](#pattern-5--simulate-latency)
    - [Pattern 6 — WebSocket Real-time Feed](#pattern-6--websocket-real-time-feed)
  - [See Also](#see-also)

---

## Overview

The Mock Server runs as a local HTTP/WebSocket server on a configurable port (default: `3001`). It handles incoming requests by matching them against your defined routes and returning the configured response.

| Feature | Description |
|---|---|
| **HTTP mocking** | Define routes for any method and path pattern with full control over status, headers, body, and delay |
| **Conditional rules** | Return different responses based on headers, query params, body fields, or path params |
| **Response scripts** | JavaScript snippets that generate dynamic responses — random data, counters, stateful CRUD |
| **WebSocket mocking** | Define WS endpoints with on-connect messages and pattern-matched message handlers |
| **Persistent state** | Shared in-memory `db.*` store for mocking stateful CRUD APIs across multiple routes |
| **Traffic inspector** | Live log of every request the mock server receives |
| **Import from collection** | Generate stub routes automatically from an existing request collection |
| **Import from HAR** | Replay real API traffic as mock responses |

![Mock Server panel overview](images/mock-server-overview.png)

---

## Opening the Mock Server

Click the **Mock Server** icon in the Activity Bar (left sidebar) to open the Mock Server panel.

![Mock Server panel](images/mock-server-panel.png)

---

## Starting and Stopping the Server

Use the toggle at the top of the panel to start or stop the server.

| Control | Description |
|---|---|
| **Port** | The local port to listen on. Default: `3001`. Change before starting. |
| **Start** | Launches the server. Turns green when running. |
| **Stop** | Shuts down the server. All active connections are closed. |

When the server is running, requests can be sent to:
- **HTTP**: `http://localhost:<port>/your/path`
- **WebSocket**: `ws://localhost:<port>/your/path`

> The server only listens on `localhost`. It is not accessible from other machines by default.

![Server start/stop toggle](images/mock-server-toggle.png)

---

## Route Collections

Routes can be organised into **Mock Collections** — named groups that can be enabled or disabled as a unit. This lets you switch between different mock scenarios (e.g. "Happy path", "Error scenarios", "Auth failures") without deleting routes.

| Action | How |
|---|---|
| **Create a collection** | Click **+ Collection** in the toolbar |
| **Rename a collection** | Double-click the collection name, or click the pencil icon |
| **Enable / disable** | Toggle the checkbox on the collection row — disables all its routes |
| **Add a route to a collection** | Click **+ Route** on the collection row |
| **Delete a collection** | Click the ✕ on the collection row — routes become uncollected (not deleted) |

Routes not assigned to any collection appear in the **Uncollected Routes** section at the top.

![Mock route collections](images/mock-server-collections.png)

---

## Managing Routes

### Route List Columns

| Column | Description |
|---|---|
| ☑ | Enabled/disabled checkbox |
| **Method** | HTTP method (colour-coded), `ANY` for wildcard, `WS` for WebSocket |
| **Path** | URL path pattern (e.g. `/api/users/:id`) |
| **Status** | HTTP status code (colour-coded) |
| **Delay** | Simulated response delay in ms |
| Actions | **Edit** / **✕ Delete** buttons |

### Adding a Route

Click **+ Route** in the toolbar (or on a collection row) to open the Route Editor with a blank route pre-filled with sensible defaults.

### Editing a Route

Click **Edit** on any route row to open the Route Editor pre-populated with that route's settings.

### Enabling and Disabling Routes

Toggle the checkbox on any route or collection row. Disabled routes are greyed out and will not match incoming requests. Disabling a collection disables all routes inside it regardless of their individual state.

### Deleting a Route

Click **✕** on a route row. The deletion is immediate.

---

## HTTP Route Configuration

### Method and Path

| Field | Description |
|---|---|
| **Method** | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, or `ANY` (matches all methods) |
| **Path** | URL path with optional path parameters (e.g. `/api/users/:id`, `/api/v2/items/:category/:id`) |

Path parameters declared with `:name` are available in response body templates as `{{param.name}}` and in scripts as `req.params.name`.

### Status Code and Delay

| Field | Description |
|---|---|
| **Status Code** | HTTP status to return. Supported codes: `200`, `201`, `204`, `301`, `302`, `400`, `401`, `403`, `404`, `409`, `422`, `500`, `502`, `503` |
| **Delay (ms)** | Milliseconds to wait before responding. Simulates network latency or slow APIs (0 = no delay, max 30 000 ms) |

### Response Headers

Add one or more response headers as key-value pairs. The default `Content-Type: application/json` is pre-filled. Click **+ Add header** to add more.

### Response Body and Template Variables

The response body is a freeform text field (JSON, XML, plain text, or any format). It supports **template variables** that are resolved at request time:

| Template | Resolves to |
|---|---|
| `{{param.name}}` | Path parameter value (e.g. `:id` → `{{param.id}}`) |
| `{{query.name}}` | Query string value (e.g. `?page=2` → `{{query.page}}`) |
| `{{body.field}}` | JSON body field from the incoming request |
| `{{header.name}}` | Request header value (lowercase name) |
| `{{method}}` | Incoming HTTP method |
| `{{$uuid}}` | Random UUID v4 generated per request |
| `{{$randomInt(min,max)}}` | Random integer between min and max (inclusive) |
| `{{$randomItem(a,b,c)}}` | Random pick from a comma-separated list |
| `{{$requestCount}}` | Number of times this route has been matched (starts at 1) |

**Example — echo path param and random ID:**

```json
{
  "id": "{{param.id}}",
  "correlationId": "{{$uuid}}",
  "page": {{query.page}},
  "method": "{{method}}"
}
```

---

## Conditional Rules

Conditional Rules let a single route return different responses based on the content of the incoming request. Rules are listed in the **Conditional Rules** section of the Route Editor.

Rules are evaluated **in order**. The first rule that matches overrides the default response for that request. If no rule matches, the default response (status code + body defined at the top of the route) is returned.

![Conditional rules editor](images/mock-server-rules.png)

### Rule Sources

| Source | Inspects |
|---|---|
| **Header** | A request header value (case-insensitive name) |
| **Query** | A query string parameter value |
| **Body** | A JSON body field (top-level keys only) |
| **Param** | A path parameter value |

### Rule Operators

| Operator | Condition |
|---|---|
| `exists` | The field is present (any value) |
| `not exists` | The field is absent |
| `=` | Field value equals the specified value (string comparison) |
| `≠` | Field value does not equal the specified value |
| `contains` | Field value contains the specified substring |
| `starts with` | Field value starts with the specified prefix |

### Rule Response

Each rule defines:
- **Status code** — the overriding status code to return when the rule matches
- **Response body** — the overriding body to return (plain text or JSON string)

### Rule Evaluation Order

```
Incoming request
       │
       ▼
 Rule 1 matches? → yes → respond with Rule 1 status + body
       │ no
       ▼
 Rule 2 matches? → yes → respond with Rule 2 status + body
       │ no
       ▼
 Default response (top-level status + body)
```

**Example — return 401 if Authorization header is missing:**

| Source | Field | Operator | Value |
|---|---|---|---|
| Header | `authorization` | not exists | — |

→ Status `401`, Body `{"error":"Unauthorized"}`

---

## Response Scripts

For complex dynamic logic, a **Response Script** (JavaScript) can be attached to any HTTP route. The script runs before rules and the default response.

![Response script editor](images/mock-server-script-editor.png)

Call `respond(status, body)` inside the script to return a custom response. If the script runs without calling `respond()`, evaluation falls through to rules and then the default response.

**Example — stateful counter:**

```js
const count = (db.get('requestCount') ?? 0) + 1;
db.set('requestCount', count);
respond(200, { count, message: `This route has been called ${count} times` });
```

**Example — CRUD mock for a users collection:**

```js
if (req.method === 'POST') {
  const created = db.push('users', { id: Date.now().toString(), ...req.body });
  respond(201, created);
} else if (req.method === 'GET') {
  respond(200, db.list('users'));
}
```

### The `req` Object

| Property | Type | Description |
|---|---|---|
| `req.method` | `string` | HTTP method (e.g. `"GET"`) |
| `req.path` | `string` | Request path (e.g. `"/api/users/42"`) |
| `req.headers` | `object` | Request headers as a key-value object (lowercase names) |
| `req.query` | `object` | Parsed query string parameters |
| `req.params` | `object` | Path parameters extracted from the route pattern |
| `req.body` | `any` | Parsed JSON body (or raw string if not JSON) |
| `req.requestCount` | `number` | Number of times this route has been matched |

### The `respond()` Function

```js
respond(status, body)
respond(status, body, headers)
```

| Parameter | Type | Description |
|---|---|---|
| `status` | `number` | HTTP status code to return |
| `body` | `any` | Response body — objects are serialized to JSON automatically |
| `headers` | `object` | Optional extra response headers (key-value pairs) |

### Persistent State — `db.*`

The `db` object is a shared in-memory key-value store accessible from **all route scripts**. It persists across requests for the lifetime of the server session (cleared when the server stops or when you click **Clear DB**).

| Method | Description |
|---|---|
| `db.get(key)` | Read a value |
| `db.set(key, value)` | Write a value |
| `db.push(collection, item)` | Append an item to an array collection and return it |
| `db.list(collection)` | Return all items in a collection |
| `db.findById(collection, id)` | Find an item by its `id` field |
| `db.upsertById(collection, id, patch)` | Update an item by `id`, or insert if not found |
| `db.removeById(collection, id)` | Remove an item by `id` |
| `db.clear(collection?)` | Clear a collection, or the entire store if no argument |

### Priority Order

```
Script (calls respond()) → wins immediately
Script (no respond() call) → falls through
       ↓
Conditional Rules (first match) → wins
No rule matches → falls through
       ↓
Default response (top-level status + body)
```

> Scripts have a **2-second timeout**. If a script takes longer, the default response is returned.

---

## WebSocket Routes

Select **WebSocket** as the route type to define a WS endpoint. WebSocket routes only require a **Path** (e.g. `/ws/events`).

Clients connect with:
```
ws://localhost:<port>/ws/events
```

![WebSocket route configuration](images/mock-server-websocket.png)

### On-Connect Events

Messages sent automatically to a client immediately after it connects. Define one or more events, each with:

| Field | Description |
|---|---|
| **Payload** | The message text to send (supports template variables) |
| **Delay (ms)** | Wait this many milliseconds after connect before sending (0 = immediately) |

Multiple on-connect events are sent in order, each with its own delay.

**Example — send a welcome message then a status update:**

```
Event 1: {"type":"welcome","id":"{{$uuid}}"}    delay: 0
Event 2: {"type":"status","state":"ready"}        delay: 500
```

**WS template variables:**

`{{$uuid}}` · `{{$timestamp}}` · `{{$isoDate}}` · `{{$randomInt(1,100)}}` · `{{$randomItem(a,b,c)}}` · `{{query.x}}` · `{{param.id}}` · `{{header.x}}`

### Message Handlers

Define responses to specific incoming messages. When a client sends a message that matches the **pattern**, the configured **response** is sent back.

| Field | Description |
|---|---|
| **If message =** | The exact message to match. JSON and XML patterns are matched ignoring whitespace differences. |
| **→ send** | The message to send back. Supports template variables. `{{body.field}}` extracts fields from the matched JSON. |

**Example — ping/pong:**

| Pattern | Response |
|---|---|
| `{"action":"ping"}` | `{"action":"pong","ts":"{{$timestamp}}"}` |
| `{"action":"subscribe","channel":"prices"}` | `{"subscribed":true,"channel":"prices","id":"{{$uuid}}"}` |

---

## Importing Routes

### Import from Collection

Import routes generated from an existing request collection. Each request in the collection becomes a stub route (method + path extracted from the request URL, body preset to `{"ok":true}`).

1. Click **Import → From Collection** in the toolbar.
2. Select the collection to import from.
3. Review the generated routes — edit them individually to add proper response bodies.

This is the fastest way to stub out an entire API surface for development.

### Import from HAR File

Import routes from a [HAR (HTTP Archive)](https://en.wikipedia.org/wiki/HAR_(file_format)) file captured by browser DevTools or another proxy tool.

1. Click **Import → From HAR File** and select a `.har` file.
2. Each captured request/response becomes a ready-to-use mock route, with the real response body, headers, and status code pre-filled.
3. Disable individual routes you don't need, or edit bodies to normalise them.

This is useful for recording real API traffic and replaying it as a fully offline mock.

---

## Traffic Inspector

The **Traffic Inspector** is a live log of every request matched by the mock server.

![Traffic inspector panel](images/mock-server-traffic.png)

Each log entry shows:

| Column | Description |
|---|---|
| **Timestamp** | Time the request was received |
| **Method** | HTTP method |
| **Path** | Request path including query string |
| **Matched route** | The route that handled the request (or `No match` if no route applied) |
| **Status** | Response status returned |
| **Duration** | Time to respond (including configured delay) |

Click an entry to expand it and see:
- Request headers and body
- Response headers and body sent by the mock server

Click **Clear Log** to reset the inspector.

---

## Persistent State Database

The **DB Inspector** panel shows the current contents of the in-memory `db.*` store — all collections and key-value pairs written by route scripts.

Click **Clear DB** to reset the entire store. Individual collections can be cleared from scripts using `db.clear('collectionName')`.

The store resets automatically when the server stops.

---

## Using the Mock Server with the Collection Runner

When the Mock Server is running and you enable **Run in Mock Server** in the Collection Runner configuration, all requests in the run are routed through the mock server at `http://localhost:<port>`. The URL base of each request is replaced with the mock server base URL.

This lets you run a full collection test suite against mock responses:
- Predictable data for deterministic test assertions
- Error scenario coverage (401, 500, timeouts) without modifying the real API
- Offline testing during development or in CI environments

See [Collection Runner](Collection-Runner#mock-server-mode) for setup details.

---

## Common Patterns

### Pattern 1 — Static Stub (Simplest)

Define the path, choose `200`, paste a JSON body. Done.

```
GET  /api/health
Status: 200
Body:   {"status":"ok","version":"1.0.0"}
```

---

### Pattern 2 — Simulate Auth Failure

Use a conditional rule to return `401` when the `Authorization` header is missing.

**Route: `GET /api/me`**

| Rule | If header `authorization` not exists → `401` `{"error":"Unauthorized"}` |
|---|---|

Default response: `200` with a mock user object.

---

### Pattern 3 — Dynamic Response with Path Param

Echo the path parameter back in the response body using a template variable.

```
GET /api/users/:id
Status: 200
Body:
{
  "id": {{param.id}},
  "name": "Mock User {{param.id}}",
  "email": "user{{param.id}}@example.com",
  "createdAt": "{{$isoDate}}"
}
```

---

### Pattern 4 — In-memory CRUD API

Use a single route with `ANY` method and a script to handle all CRUD operations.

```
ANY  /api/items
```

**Script:**

```js
if (req.method === 'GET') {
  const id = req.params.id;
  if (id) {
    const item = db.findById('items', id);
    if (!item) return respond(404, { error: 'Not found' });
    respond(200, item);
  } else {
    respond(200, db.list('items'));
  }
} else if (req.method === 'POST') {
  const item = db.push('items', { id: `${Date.now()}`, ...req.body });
  respond(201, item);
} else if (req.method === 'PUT') {
  const updated = db.upsertById('items', req.params.id, req.body);
  respond(updated ? 200 : 404, updated ?? { error: 'Not found' });
} else if (req.method === 'DELETE') {
  const removed = db.removeById('items', req.params.id);
  respond(removed ? 204 : 404, removed ? null : { error: 'Not found' });
}
```

You'll need two routes: `ANY /api/items` and `ANY /api/items/:id` — both sharing the same script.

---

### Pattern 5 — Simulate Latency

Set a **Delay** of `1500` ms on a route to test front-end loading states and timeout handling without touching a real API.

---

### Pattern 6 — WebSocket Real-time Feed

```
WS  /ws/feed
```

**On-connect events:**

```json
{"type":"init","id":"{{$uuid}}","connected":true}
```
Delay: 0

```json
{"type":"tick","value":{{$randomInt(1,100)}},"ts":"{{$timestamp}}"}
```
Delay: 1000

---

## See Also

- [Collection Runner](Collection-Runner) — run your collection against mock responses
- [Scripting](Scripting) — pre-request and test scripts for requests hitting the mock server
- [Import & Export](Import-and-Export) — HAR import for capturing real traffic
- [Collections & Requests](Collections-and-Requests) — building the collection to import routes from
