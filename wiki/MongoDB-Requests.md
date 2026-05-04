# MongoDB Requests

Apilix supports sending requests directly to MongoDB databases in addition to HTTP APIs. MongoDB requests live in the same collection as your HTTP requests, share the same variable substitution, pre-request and test scripting engine, and run seamlessly inside the Collection Runner — including CSV-driven and multi-iteration runs.

---

## Table of Contents

- [MongoDB Requests](#mongodb-requests)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [The MongoDB Request Panel](#the-mongodb-request-panel)
    - [Query Tab](#query-tab)
    - [Connection Tab](#connection-tab)
    - [Pre-request Tab](#pre-request-tab)
    - [Tests Tab](#tests-tab)
    - [Docs Tab](#docs-tab)
  - [Connections](#connections)
    - [Direct Connection](#direct-connection)
    - [Named Connections](#named-connections)
    - [Managing Named Connections](#managing-named-connections)
    - [Authentication Override](#authentication-override)
  - [Database and Collection Discovery](#database-and-collection-discovery)
  - [Creating a MongoDB Request](#creating-a-mongodb-request)
  - [Operations](#operations)
    - [find](#find)
    - [aggregate](#aggregate)
    - [insert](#insert)
    - [update](#update)
    - [delete](#delete)
    - [count](#count)
    - [distinct](#distinct)
    - [script](#script)
  - [Pipeline Stage Snippets](#pipeline-stage-snippets)
  - [Variables in MongoDB Requests](#variables-in-mongodb-requests)
  - [Transactions](#transactions)
  - [Result Format](#result-format)
  - [Size and Timeout Limits](#size-and-timeout-limits)
  - [Scripting for MongoDB Requests](#scripting-for-mongodb-requests)
    - [Test Scripts](#test-scripts)
    - [Pre-request Scripts](#pre-request-scripts)
    - [mongoStatus Values](#mongostatus-values)
  - [Collection Runner](#collection-runner)
    - [Mixed HTTP + MongoDB Collections](#mixed-http--mongodb-collections)
    - [No-retry Policy](#no-retry-policy)
  - [CLI Usage](#cli-usage)
  - [Mock Server Compatibility](#mock-server-compatibility)
  - [Common Patterns](#common-patterns)
    - [Pattern 1 — Seed data before an HTTP test](#pattern-1--seed-data-before-an-http-test)
    - [Pattern 2 — Capture an inserted ID and use it in HTTP requests](#pattern-2--capture-an-inserted-id-and-use-it-in-http-requests)
    - [Pattern 3 — Assert database state after an API call](#pattern-3--assert-database-state-after-an-api-call)
    - [Pattern 4 — CSV-driven inserts](#pattern-4--csv-driven-inserts)
  - [See Also](#see-also)

---

## Overview

MongoDB requests are first-class citizens in Apilix. Each request is stored as part of a collection and serialised as:

```json
{
  "name": "Find active users",
  "request": {
    "method": "MONGO",
    "requestType": "mongodb",
    "url": { "raw": "" },
    "mongodb": {
      "connection": { "mode": "direct", "uri": "{{mongoUri}}" },
      "database": "mydb",
      "collection": "users",
      "operation": "find",
      "filter": "{ \"status\": \"active\" }",
      "limit": 25
    }
  }
}
```

All `{{variable}}` tokens in the `mongodb` object are resolved at send time using the same scope hierarchy (environment → collection variables → globals → data row) used by HTTP requests.

---

## The MongoDB Request Panel

When a `MONGO` request is open in the editor, the request panel is organised into five tabs:

| Tab | Purpose |
|---|---|
| **Query** | Configure the database, collection, operation, and all operation-specific fields |
| **Connection** | Set the connection mode, URI or named connection reference, and optional auth override |
| **Pre-request** | JavaScript that runs before the request is sent |
| **Tests** | JavaScript that runs after a response is received |
| **Docs** | Free-form Markdown notes attached to this request |

This layout mirrors the standard HTTP request panel so the workflow feels consistent whether you are working with HTTP or MongoDB requests.

### Query Tab

The Query tab is the main working area for a MongoDB request. It contains:

- **Database** field — the target database name. Supports `{{variable}}` tokens. A **fetch button** (list icon) beside the field opens a dropdown of databases available on the live server; click any name to populate the field automatically.
- **Collection** field — the target collection name. Supports `{{variable}}` tokens. A **fetch button** becomes active once a database name is resolved; click it to list collections in that database.
- **Operation** selector — choose from `find`, `aggregate`, `insert`, `update`, `delete`, `count`, `distinct`, or `script`.
- **Operation-specific fields** — filter, projection, pipeline, documents, etc. (see [Operations](#operations)).
- **Advanced** — collapsible section containing **Use Transaction** and **Max Time (ms)**.

> **Tip:** The fetch buttons use the **resolved** URI and database name, meaning `{{variable}}` tokens are substituted using the active environment before the server is contacted. If the URI is still a literal `{{mongoUri}}` placeholder and the variable is not set, the buttons are disabled.

### Connection Tab

All connection settings for a MongoDB request live in the **Connection** tab, keeping the Query tab focused on the operation itself.

**Connection Mode** — choose one of:

- **Direct URI** — type or paste a MongoDB URI directly. Supports `{{variable}}` tokens so you can keep the actual URI in an environment (e.g. `{{mongoUri}}`).
- **Named Connection** — pick a saved connection by ID. Named connections store the URI encrypted on disk; the URI is never sent to the browser. A **Refresh** button reloads the list from the server.

**Auth Override** — an optional collapsible section that injects credentials into the URI at send time without modifying the stored URI. Useful for testing different credential sets against the same endpoint without editing the connection. See [Authentication Override](#authentication-override).

### Pre-request Tab

JavaScript that runs before the MongoDB request is dispatched. Has access to the full `apx.*` scripting API. Commonly used to compute dynamic filter values or set environment variables consumed by the request body.

### Tests Tab

JavaScript that runs after the response is received. Use `apx.test()` and `apx.expect()` to assert on the returned documents. See [Scripting for MongoDB Requests](#scripting-for-mongodb-requests).

### Docs Tab

Markdown notes stored with the request. Toggle between **Edit** and **Preview** modes. Rendered output supports all standard Markdown formatting.

---

## Connections

Every MongoDB request must specify how to connect to the database. There are two modes.

### Direct Connection

Inline a URI directly in the request (typically as a variable reference so you can swap it per environment):

```json
"connection": {
  "mode": "direct",
  "uri": "{{mongoUri}}"
}
```

Set `mongoUri` to `mongodb://localhost:27017` in your **Development** environment and to your Atlas URI in **Production**.

### Named Connections

Store a connection URI once and reference it by a short identifier. This keeps URIs out of collection files (which may be version-controlled) and centralises credential rotation.

```json
"connection": {
  "mode": "named",
  "connectionId": "atlas-dev"
}
```

Named connections are stored encrypted on disk at:

- **macOS:** `~/.apilix/mongo-connections.enc.json`
- **Windows / Linux:** `~/.apilix/mongo-connections.enc.json`

The file is AES-256-GCM encrypted. See [Security and Encrypted Data](Security-and-Encrypted-Data#mongodb-connection-registry) for details.

### Managing Named Connections

Named connections are managed via the server REST API. A UI panel is available in the app Settings modal under **MongoDB Connections**.

**Create or update a connection:**

```bash
curl -X POST http://localhost:3001/api/mongo/connections \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "atlas-dev",
    "name": "Atlas Development",
    "uri": "mongodb+srv://user:pass@cluster.mongodb.net",
    "database": "mydb",
    "authMode": "scram"
  }'
```

**List connections** (URIs are never returned):

```bash
curl http://localhost:3001/api/mongo/connections
```

```json
{
  "connections": [
    {
      "id": "atlas-dev",
      "name": "Atlas Development",
      "database": "mydb",
      "authMode": "scram",
      "hasUri": true
    }
  ]
}
```

**Delete a connection:**

```bash
curl -X DELETE http://localhost:3001/api/mongo/connections/atlas-dev
```

### Authentication Override

The **Auth Override** section in the Connection tab (and the corresponding `auth` block in the serialised JSON) lets you inject credentials at send time without modifying the stored URI. This is useful for:

- Testing multiple credential sets against a shared connection
- Keeping the URI in version control while keeping passwords in environments
- Switching auth mechanisms between environments

Specify an `auth` block inside the `mongodb` object to override the credentials baked into the URI:

```json
"auth": {
  "mode": "scram",
  "username": "{{mongoUser}}",
  "password": "{{mongoPassword}}",
  "authSource": "admin"
}
```

| `mode` | Mechanism | Notes |
|---|---|---|
| `scram` | SCRAM-SHA-1/256 (default) | Standard username + password |
| `x509` | MONGODB-X509 | Client certificate must be in the URI or connection string |
| `ldap-plain` | PLAIN (LDAP) | Enterprise Atlas only |
| `oidc` | MONGODB-OIDC | Atlas workload identity; access token via `oidcAccessToken` |

---

## Database and Collection Discovery

The **Query** tab provides inline fetch buttons that list available databases and collections directly from the live MongoDB server — without leaving the editor.

**Database fetch button**

Click the list icon beside the **Database** field. Apilix sends the resolved URI to the server, which calls `listDatabases()` on the admin database and returns the names. Click any name in the dropdown to populate the field.

- The button is **disabled** if the resolved URI is empty (e.g. the variable `{{mongoUri}}` is not set in the active environment).
- The button is **active** when running against a direct URI where the variable is resolved, or when a named connection's URI can be resolved server-side.

**Collection fetch button**

Click the list icon beside the **Collection** field. Requires both a resolved URI and a non-empty database name. Returns all collections in the specified database, sorted alphabetically.

> **Security note:** Both fetch endpoints (`POST /api/mongo/introspect/databases` and `POST /api/mongo/introspect/collections`) require the URI to use the `mongodb://` or `mongodb+srv://` scheme. Other schemes are rejected with HTTP 400.

---

## Creating a MongoDB Request

1. In the **Sidebar**, right-click a collection or folder and choose **New Request** (or click **+**).
2. In the **Request Builder**, open the **Method** dropdown and select `MONGO`.
3. The URL bar is hidden — the panel switches to the MongoDB editor with five tabs.
4. In the **Connection** tab, set the connection mode and URI (or pick a named connection).
5. In the **Query** tab, set the database, collection, and operation.
6. Click **Send** (or press **⌘↵** / **Ctrl+Enter**).

The response panel shows the returned documents as formatted JSON. The **Console** panel logs each send with the operation and `mongoStatus`.

> **Tip:** Use the fetch buttons next to Database and Collection to auto-populate those fields from the live server rather than typing names manually.

---

## Operations

All operation-specific fields are provided as **JSON strings** that are parsed at send time. `{{variable}}` tokens inside these strings are resolved before parsing.

### find

Retrieve documents matching a filter.

```json
{
  "connection": { "mode": "direct", "uri": "{{mongoUri}}" },
  "database": "mydb",
  "collection": "orders",
  "operation": "find",
  "filter": "{ \"status\": \"pending\", \"amount\": { \"$gt\": 100 } }",
  "projection": "{ \"_id\": 1, \"customerId\": 1, \"amount\": 1 }",
  "sort": "{ \"createdAt\": -1 }",
  "skip": 0,
  "limit": 50
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `filter` | JSON string | `{}` | MongoDB query filter |
| `projection` | JSON string | — | Fields to include/exclude |
| `sort` | JSON string | — | Sort specification |
| `skip` | number | `0` | Documents to skip |
| `limit` | number | `50` | Max documents to return (1–5000) |

### aggregate

Run an aggregation pipeline.

```json
{
  "connection": { "mode": "named", "connectionId": "atlas-dev" },
  "database": "analytics",
  "collection": "events",
  "operation": "aggregate",
  "pipeline": "[{ \"$match\": { \"type\": \"purchase\" } }, { \"$group\": { \"_id\": \"$userId\", \"total\": { \"$sum\": \"$amount\" } } }]",
  "limit": 100
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `pipeline` | JSON array string | `[]` | Ordered list of pipeline stages |
| `limit` | number | `50` | Max documents returned from the final stage (1–5000) |

> **Tip:** Use the [Pipeline Stage Snippets](#pipeline-stage-snippets) button to insert pre-filled stage templates without leaving the editor.

### insert

Insert one or more documents.

```json
{
  "connection": { "mode": "direct", "uri": "{{mongoUri}}" },
  "database": "mydb",
  "collection": "products",
  "operation": "insert",
  "documents": "[{ \"name\": \"{{productName}}\", \"price\": {{price}} }]"
}
```

| Field | Type | Description |
|---|---|---|
| `documents` | JSON array string | One or more documents to insert. Single-element array uses `insertOne`; multi-element uses `insertMany`. |

### update

Update one or many matching documents.

```json
{
  "connection": { "mode": "direct", "uri": "{{mongoUri}}" },
  "database": "mydb",
  "collection": "orders",
  "operation": "update",
  "filter": "{ \"orderId\": \"{{orderId}}\" }",
  "update": "{ \"$set\": { \"status\": \"shipped\" } }",
  "updateMode": "one"
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `filter` | JSON string | `{}` | Documents to match |
| `update` | JSON string | — | MongoDB update document (must use update operators like `$set`) |
| `updateMode` | `"one"` \| `"many"` | `"one"` | Update the first match or all matches |

### delete

Delete one or many matching documents.

```json
{
  "connection": { "mode": "direct", "uri": "{{mongoUri}}" },
  "database": "mydb",
  "collection": "sessions",
  "operation": "delete",
  "filter": "{ \"expiresAt\": { \"$lt\": {{now}} } }",
  "deleteMode": "many"
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `filter` | JSON string | `{}` | Documents to match |
| `deleteMode` | `"one"` \| `"many"` | `"one"` | Delete only the first match or all matches |

### count

Count documents matching a filter.

```json
{
  "connection": { "mode": "direct", "uri": "{{mongoUri}}" },
  "database": "mydb",
  "collection": "users",
  "operation": "count",
  "filter": "{ \"role\": \"admin\" }"
}
```

Response body: `{ "count": 42 }`

### distinct

Get distinct values for a field across matching documents.

```json
{
  "connection": { "mode": "direct", "uri": "{{mongoUri}}" },
  "database": "mydb",
  "collection": "orders",
  "operation": "distinct",
  "distinctField": "status",
  "filter": "{}"
}
```

Response body: `["pending", "shipped", "delivered", "cancelled"]`

### script

Run arbitrary JavaScript in a server-side VM sandbox with access to the MongoDB driver via a `db` object. Use this for complex operations that cannot be expressed as a single query.

```json
{
  "connection": { "mode": "direct", "uri": "{{mongoUri}}" },
  "database": "mydb",
  "collection": "",
  "operation": "script",
  "script": "(async () => { const users = await db.collection('users').find({ active: true }).toArray(); return users.map(u => u.email); })()"
}
```

The response body is the resolved value returned by the script. If the script does not explicitly return a value, Apilix falls back to the `result` variable.

### Writing async Mongo scripts

MongoDB scripts run in a Node.js `vm` sandbox. Top-level `await` is not available, so wrap async work in an async IIFE or return a Promise chain.

**Return a value from an async wrapper:**

```js
(async () => {
  const users = await db.collection('users')
    .find({ active: true })
    .toArray();

  return users.map(user => user.email);
})()
```

**Use the `result` output variable from an async wrapper:**

```js
(async () => {
  const users = await db.collection('users')
    .find({ active: true })
    .toArray();

  result = users.map(user => user.email);
})()
```

**Equivalent Promise-chain form:**

```js
db.collection('users')
  .find({ active: true })
  .toArray()
  .then(users => users.map(user => user.email))
```

### Multiple queries in one script

You can run multiple queries against the same configured database and combine them into one returned object.

```js
(async () => {
  const account = await db.collection('accounts')
    .find({ _id: 'VI_41833' })
    .limit(1)
    .toArray();

  const contacts = await db.collection('contacts')
    .find({ accountId: 'VI_41833' })
    .toArray();

  return {
    account,
    contacts,
    summary: {
      accountCount: account.length,
      contactCount: contacts.length,
    },
  };
})()
```

The `db` object is already bound to the request's configured database. To query a different database, use a separate MongoDB request.

### Promise values inside returned objects

Do not place unresolved Promises directly inside `result` or another returned object. Apilix awaits the script's top-level returned Promise, but it does not recursively await Promise values nested inside an object.

This returns an empty object for `query` because `query` is still a Promise:

```js
const query = db.collection('accounts')
  .find({ _id: 'VI_41833' })
  .limit(1)
  .toArray();

result = { query };
```

Resolve the query first:

```js
(async () => {
  const query = await db.collection('accounts')
    .find({ _id: 'VI_41833' })
    .limit(1)
    .toArray();

  result = { query };
})()
```

**Available globals inside `script`:**

| Global | Description |
|---|---|
| `db` | MongoDB `Db` instance with session threading |
| `db.collection(name)` | Returns a wrapped collection with all CRUD methods |
| `ObjectId` | BSON `ObjectId` constructor |
| `BSON.ObjectId` | Alias for `ObjectId` |
| `result` | Output variable — set this to the value you want returned |

> **Note:** The script runs in a Node.js `vm` sandbox. `require`, `process`, and file-system access are not available. Network calls outside MongoDB are not permitted.

---

## Pipeline Stage Snippets

When the **aggregate** operation is selected, a **Stage** button appears next to the **Pipeline** field label in the Query tab. Clicking it opens a dropdown of 19 pre-filled pipeline stage templates:

| Stage | Description |
|---|---|
| `$match` | Filter documents by condition |
| `$group` | Group by a field and compute accumulators |
| `$project` | Include, exclude, or compute fields |
| `$sort` | Sort the pipeline stream |
| `$limit` | Cap the number of documents |
| `$skip` | Skip a number of documents |
| `$lookup` | Left outer join with another collection |
| `$unwind` | Deconstruct an array field into separate documents |
| `$addFields` / `$set` | Compute and add new fields |
| `$count` | Count documents and output a single total |
| `$facet` | Run multiple sub-pipelines in parallel |
| `$bucket` | Categorise documents into ranges |
| `$replaceRoot` | Promote a nested document to the top level |
| `$out` | Write results to a new collection |
| `$merge` | Merge results into an existing collection |
| `$sample` | Return a random sample of documents |
| `$sortByCount` | Group and sort by occurrence count |
| `$graphLookup` | Recursive graph traversal join |

Clicking a stage name **appends** the template to the current pipeline array. If the pipeline field does not yet contain a valid JSON array, the template is appended as text so you never lose work.

Each template includes placeholder field names (e.g. `"field"`, `"otherCollection"`) — edit them before sending.

---

## Variables in MongoDB Requests

All `{{variable}}` tokens inside the `mongodb` configuration object are resolved before the operation is executed. This includes values inside JSON strings:

```json
"filter": "{ \"userId\": \"{{currentUserId}}\", \"age\": { \"$gt\": {{minAge}} } }"
```

This lets you parameterise any field — database name, collection name, filter values, pipeline stages, or script code — using the standard environment/globals/data-row system.

---

## Transactions

Set `"useTransaction": true` to wrap the operation in a MongoDB multi-document transaction. Apilix opens a client session, runs the operation with `withTransaction()`, and closes the session automatically.

```json
{
  "connection": { "mode": "named", "connectionId": "replica-set" },
  "database": "mydb",
  "collection": "accounts",
  "operation": "update",
  "filter": "{ \"_id\": \"{{accountId}}\" }",
  "update": "{ \"$inc\": { \"balance\": -{{amount}} } }",
  "useTransaction": true
}
```

> **Note:** Transactions require a MongoDB replica set or sharded cluster. Standalone `mongod` instances do not support multi-document transactions.

---

## Result Format

A successful MongoDB request returns a JSON body containing the operation result:

| Operation | Result shape |
|---|---|
| `find` | Array of matching documents |
| `aggregate` | Array of pipeline output documents |
| `insert` (one) | `{ "acknowledged": true, "insertedId": "..." }` |
| `insert` (many) | `{ "acknowledged": true, "insertedCount": N, "insertedIds": {...} }` |
| `update` (one) | `{ "acknowledged": true, "matchedCount": 1, "modifiedCount": 1 }` |
| `update` (many) | `{ "acknowledged": true, "matchedCount": N, "modifiedCount": N }` |
| `delete` | `{ "acknowledged": true, "deletedCount": N }` |
| `count` | `{ "count": N }` |
| `distinct` | Array of distinct values |
| `script` | Value of the `result` variable at the end of the script |

The response panel shows the result as formatted, syntax-highlighted JSON. The status bar shows `MONGO_SUCCESS` for successful operations and `MONGO_ERROR` on failure.

---

## Size and Timeout Limits

| Limit | Value |
|---|---|
| Max result size | 10 MB — results exceeding this are truncated with a `/* truncated */` marker and status `MONGO_PARTIAL` |
| Max operation time | 1800 s (30 minutes) — enforced per-operation and per-run |
| Max `limit` for find/aggregate | 5000 documents |

---

## Scripting for MongoDB Requests

Pre-request and test scripts work exactly the same way for MongoDB requests as they do for HTTP requests.

### Test Scripts

The `apx.response` object is available in test scripts. Use it to assert on the documents returned.

**Assert a count:**

```js
apx.test('Returns 3 documents', () => {
  const docs = apx.response.json();
  apx.expect(docs).to.be.an('array').with.lengthOf(3);
});
```

**Assert a field on the first document:**

```js
apx.test('First document has expected status', () => {
  const docs = apx.response.json();
  apx.expect(docs[0].status).to.equal('active');
});
```

**Assert count result:**

```js
apx.test('Has admin users', () => {
  const result = apx.response.json();
  apx.expect(result.count).to.be.above(0);
});
```

**Assert operation succeeded:**

```js
apx.test('Insert acknowledged', () => {
  const result = apx.response.json();
  apx.expect(result.acknowledged).to.be.true;
  apx.expect(result.insertedId).to.be.a('string');
});
```

**Capture a value for later requests:**

```js
const docs = apx.response.json();
if (docs.length > 0) {
  apx.environment.set('latestOrderId', String(docs[0]._id));
}
```

**Assert `mongoStatus`:**

```js
apx.test('Operation succeeded', () => {
  apx.expect(apx.response.status).to.equal(2200);
});
```

### Pre-request Scripts

Pre-request scripts run before the MongoDB request is dispatched. You can use them to compute dynamic filter values:

```js
// Set a time window for the last 24 hours
const now = Date.now();
const yesterday = now - (24 * 60 * 60 * 1000);
apx.environment.set('now', now.toString());
apx.environment.set('yesterday', yesterday.toString());
```

Then reference them in the filter:

```json
"filter": "{ \"createdAt\": { \"$gte\": {{yesterday}}, \"$lte\": {{now}} } }"
```

### mongoStatus Values

The status field for MongoDB responses uses non-HTTP codes:

| `statusText` | `status` code | Meaning |
|---|---|---|
| `MONGO_SUCCESS` | `2200` | Operation completed, result fits within the 10 MB limit |
| `MONGO_PARTIAL` | `2400` | Operation completed, but the result was truncated at 10 MB |
| `MONGO_ERROR` | `0` | Operation failed — error message is in the response body |

In test scripts, check `apx.response.status === 2200` for a clean success.

---

## Collection Runner

### Mixed HTTP + MongoDB Collections

Collections can contain any mix of HTTP and MongoDB requests. The runner processes them in sequence — each MongoDB request uses the current environment and collection variable state, just like an HTTP request.

**Status column in the runner UI:** MongoDB requests display their `mongoStatus` (`MONGO_SUCCESS`, `MONGO_PARTIAL`, or `MONGO_ERROR`) in the status column instead of an HTTP code. The method column shows the operation name (e.g. `MONGO:FIND`, `MONGO:INSERT`).

**Variable propagation:** Variables captured by a MongoDB test script (`apx.environment.set(...)`) are immediately available to subsequent requests in the same iteration, whether HTTP or MongoDB.

### No-retry Policy

The retry mechanism does not apply to MongoDB requests. Each MongoDB request runs exactly once per iteration regardless of the **Max Retries** setting. This is intentional — write operations (insert, update, delete) must not be retried automatically without the caller explicitly handling idempotency.

---

## CLI Usage

Run a collection containing MongoDB requests from the command line:

```bash
# Direct URI via variable in environment file
apilix run ./collection.json -e ./environment.json --reporter json

# Override the MongoDB URI at the command line (all Mongo requests use this connection)
apilix run ./collection.json \
  --mongo-uri "mongodb+srv://user:pass@cluster.mongodb.net" \
  --mongo-db mydb \
  --reporter json
```

**MongoDB CLI flags:**

| Flag | Description |
|---|---|
| `--mongo-uri <uri>` | Override the MongoDB connection URI for all MongoDB requests in the collection. Creates a synthetic named connection `__cli` and rewrites all Mongo request connection refs to use it. |
| `--mongo-db <db>` | Override the MongoDB database name for all MongoDB requests. |

The `--mongo-uri` flag is useful in CI pipelines where the connection URI is an environment secret and you want to avoid storing it in the exported collection or environment JSON files:

```bash
apilix run ./integration-tests.json \
  --mongo-uri "$MONGO_URI" \
  --mongo-db "$MONGO_DB" \
  -e ./ci-environment.json \
  --reporter junit \
  --out ./artifacts/apilix.junit.xml
```

In the table reporter, MongoDB status values (`MONGO_SUCCESS`, `MONGO_ERROR`) are displayed in cyan to distinguish them from HTTP status codes.

---

## Mock Server Compatibility

MongoDB requests **cannot** be sent to the Apilix mock server. The **Send to Mock** button is disabled when a MONGO method is selected. This is by design — the mock server handles only HTTP traffic.

---

## Common Patterns

### Pattern 1 — Seed data before an HTTP test

Use a MongoDB `insert` request at the start of a collection run to ensure test data exists, followed by HTTP requests that exercise the API:

```
1. [MONGO:INSERT]  Seed test user
2. [POST]          POST /api/login  (uses seeded user credentials)
3. [GET]           GET  /api/profile
4. [MONGO:DELETE]  Clean up test user
```

### Pattern 2 — Capture an inserted ID and use it in HTTP requests

```
Request 1 — MONGO:INSERT  (insert order document)
  Test script:
    const result = apx.response.json();
    apx.environment.set('orderId', String(result.insertedId));

Request 2 — GET /api/orders/{{orderId}}
  Verifies the API can retrieve the document just inserted.
```

### Pattern 3 — Assert database state after an API call

```
Request 1 — POST /api/users  (creates a user via API)
  Test script:
    const body = apx.response.json();
    apx.environment.set('newUserId', body.id);

Request 2 — MONGO:FIND  (verify the API actually wrote to the database)
  Config:
    filter: "{ \"_id\": \"{{newUserId}}\" }"
  Test script:
    const docs = apx.response.json();
    apx.test('User exists in DB', () => {
      apx.expect(docs).to.have.lengthOf(1);
      apx.expect(docs[0].email).to.equal('test@example.com');
    });
```

### Pattern 4 — CSV-driven inserts

Supply a CSV file where each row becomes one document to insert:

**data.csv:**

```csv
name,email,role
Alice,alice@example.com,admin
Bob,bob@example.com,user
```

**Collection request — MONGO:INSERT:**

```json
{
  "operation": "insert",
  "documents": "[{ \"name\": \"{{name}}\", \"email\": \"{{email}}\", \"role\": \"{{role}}\" }]"
}
```

**CLI run:**

```bash
apilix run ./collection.json \
  --mongo-uri "$MONGO_URI" \
  --mongo-db mydb \
  --csv ./data.csv \
  --reporter table
```

Each CSV row drives one iteration, inserting one document per run.

---

## See Also

- [Collection Runner](Collection-Runner) — multi-iteration runs, CSV data files, runner CLI flags
- [Scripting](Scripting) — full `apx.*` API reference
- [Variables & Environments](Variables-and-Environments) — variable scopes and `{{variable}}` syntax
- [Security and Encrypted Data](Security-and-Encrypted-Data#mongodb-connection-registry) — named connection encryption
