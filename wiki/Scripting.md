# Scripting

Apilix has a built-in JavaScript scripting engine that lets you automate work before and after every HTTP request. Scripts run inside a sandboxed environment with full access to response data, variable stores, and a rich assertion API.

---

## Table of Contents

- [Scripting](#scripting)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Script Execution Order](#script-execution-order)
  - [The Script Editor](#the-script-editor)
  - [Pre-request Scripts](#pre-request-scripts)
  - [Test Scripts](#test-scripts)
  - [Response Object](#response-object)
  - [XML Response Parsing](#xml-response-parsing)
  - [Assertion Chains — `apx.expect()`](#assertion-chains--apxexpect)
    - [Chainable Words (no-op)](#chainable-words-no-op)
    - [Boolean Getters](#boolean-getters)
    - [Number Guards](#number-guards)
    - [Equality \& Comparison](#equality--comparison)
    - [String Assertions](#string-assertions)
    - [Array Assertions](#array-assertions)
    - [Object Assertions](#object-assertions)
    - [Type Assertions](#type-assertions)
    - [JSON Schema Validation](#json-schema-validation)
    - [Custom Predicate](#custom-predicate)
    - [Negation](#negation)
  - [Response Helpers](#response-helpers)
  - [Soft Assertions](#soft-assertions)
  - [Skipping Tests](#skipping-tests)
  - [Variable Stores](#variable-stores)
  - [Execution Control (Runner)](#execution-control-runner)
  - [`apx.sendRequest()`](#apxsendrequest)
  - [Modifying the Request from a Script](#modifying-the-request-from-a-script)
  - [Console Output](#console-output)
  - [Test Results Display](#test-results-display)
  - [Snippet Library](#snippet-library)
  - [Common Patterns](#common-patterns)
  - [See Also](#see-also)

---

## Overview

Apilix scripts are plain JavaScript (ES2022+) with:

- **Top-level `async/await`** support — no wrapper function needed.
- **Dual prefix** — `apx.*` and `pm.*` are identical aliases. The `apx.*` prefix is the canonical form used throughout this documentation.
- **Monaco editor** with syntax highlighting, IntelliSense, and auto-complete for all `apx.*` APIs.
- **No external dependencies** — the Web Crypto API, `btoa`/`atob`, and standard globals are available.

There are two script slots per request:

| Script | Timing | `apx.response` available? |
|---|---|---|
| **Pre-request Script** | Runs before the HTTP request is sent | ❌ No |
| **Test Script** | Runs after the full response is received | ✅ Yes |

Both share the same variable stores (`apx.environment`, `apx.globals`, etc.).

![Script editor tabs — pre-request and test](images/scripting-editor-tabs.png)

---

## Script Execution Order

Scripts execute in the following order for every request send:

```
1. Collection pre-request script
2. Folder pre-request script(s)  (outer → inner)
3. Request pre-request script

→ HTTP request is sent →

4. Request test script
5. Folder test script(s)         (inner → outer)
6. Collection test script
```

Collection and folder scripts are useful for shared setup and teardown logic (e.g. setting a timestamp at the collection level so every request has it).

![Script execution order diagram](images/scripting-execution-order.png)

---

## The Script Editor

Click the **Pre-request** or **Tests** tab in the Request Builder to open the script editor.

![Script editor with IntelliSense](images/scripting-editor.png)

Key editor features:

- **IntelliSense** — type `apx.` to see all available methods with documentation tooltips.
- **Snippets button** — open the Snippet Library to insert ready-made code blocks.
- **Run** — scripts execute automatically whenever you click **Send**; there is no separate "run script" button.
- **Errors** — runtime errors and uncaught exceptions appear in the **Console** panel.

---

## Pre-request Scripts

Pre-request scripts run before the HTTP request is sent. Common uses:

- Injecting dynamic values (timestamps, UUIDs, signatures) into environment variables.
- Computing auth signatures (HMAC, JWT) just before each request.
- Fetching a fresh token if the current one is absent or expired.
- Setting headers or body fields that depend on the current time.

**Example — inject a timestamp and UUID:**

```js
// Inject Unix timestamp (ms)
apx.environment.set('timestamp', Date.now().toString());

// Generate UUID v4
const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});
apx.environment.set('requestId', uuid);
```

**Example — HMAC-SHA256 signature using the Web Crypto API:**

```js
const secret  = apx.environment.get('hmacSecret') ?? 'my-secret';
const message = apx.environment.get('timestamp')  ?? Date.now().toString();

const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
const hex = Array.from(new Uint8Array(sig))
  .map(b => b.toString(16).padStart(2, '0')).join('');

apx.environment.set('hmacSignature', hex);
```

**Example — generate a signed JWT (HS256):**

```js
const secret = apx.environment.get('jwtSecret') ?? 'my-secret';
const payload = {
  sub: apx.environment.get('userId') ?? '1234567890',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function base64url(data) {
  return btoa(JSON.stringify(data))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const header       = base64url({ alg: 'HS256', typ: 'JWT' });
const body         = base64url(payload);
const signingInput = `${header}.${body}`;

const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

apx.environment.set('jwt', `${signingInput}.${sigB64}`);
```

---

## Test Scripts

Test scripts run after the response is received. They contain one or more named test blocks, each of which passes or fails independently.

```js
apx.test("Status is 200 OK", () => {
  apx.response.to.have.status(200);
});

apx.test("Response body has a user id", () => {
  const json = apx.response.json();
  apx.expect(json.id).to.be.a('number').and.positive;
});

apx.test("Response time is acceptable", () => {
  apx.expect(apx.response.responseTime).to.be.below(500);
});
```

Key rules:

- **`apx.test(name, fn)`** — any thrown `Error` inside `fn` marks the test failed. A normal return marks it passed.
- Multiple `apx.test()` blocks are **independent** — a failure in one does not stop the others.
- Scripts support **top-level `async/await`**.

---

## Response Object

`apx.response` is available in test scripts only (it is `null` in pre-request scripts).

| Property / Method | Type | Description |
|---|---|---|
| `apx.response.code` | `number` | HTTP status code (e.g. `200`) |
| `apx.response.status` | `string` | Status text (e.g. `"OK"`) |
| `apx.response.responseTime` | `number` | Time from request send to full body receipt in ms |
| `apx.response.size` | `number` | Response body size in bytes |
| `apx.response.json()` | `any` | Parses and returns the body as JSON (throws if invalid) |
| `apx.response.text()` | `string` | Raw body as a string |
| `apx.response.headers.get(name)` | `string \| undefined` | Get a header value (case-insensitive name) |
| `apx.response.headers.has(name)` | `boolean` | Check whether a header is present |

```js
const json = apx.response.json();
const ct   = apx.response.headers.get('content-type');
console.log(`${apx.response.code} in ${apx.response.responseTime}ms — ${ct}`);
```

---

## XML Response Parsing

`apx.response.xml()`, `apx.response.xmlPath()`, and `apx.response.xmlPathAll()` are available in test scripts only. They require the response body to contain well-formed XML (including SOAP envelopes).

| Method | Returns | Description |
|---|---|---|
| `apx.response.xml()` | `Document` | Parses the body with `@xmldom/xmldom` and returns a W3C DOM Document object |
| `apx.response.xmlPath(expr)` | `string \| null` | Parses body, evaluates the XPath expression, returns text of the first match or `null` |
| `apx.response.xmlPathAll(expr)` | `string[]` | Parses body, evaluates the XPath expression, returns text of all matches |

A **`xpath`** global object is also available with the full `xpath` library surface:

| Function | Description |
|---|---|
| `xpath.select(expr, doc)` | Returns an array of matching nodes |
| `xpath.select1(expr, doc)` | Returns the first matching node or `undefined` |
| `xpath.value(expr, doc)` | Returns the text content of the first match or `''` |

```js
// Extract a SOAP token after login
apx.test("Token is present", () => {
  const doc = apx.response.xml();
  apx.expect(doc != null).to.be.true;                    // guard: parse succeeded

  const token = xpath.value('//token', doc);             // full xpath API
  apx.expect(token).to.be.a('string').and.not.empty;
  apx.environment.set('authToken', token);
});

// One-liner shorthand
const token = apx.response.xmlPath('//token');           // null if not found
apx.environment.set('authToken', token);

// All matches
const ids = apx.response.xmlPathAll('//item/id');
console.log('Item IDs:', ids);
```

> **Note:** XPath expressions must target plain element names (e.g. `//token`) or use namespace-agnostic predicates (`//*[local-name()='token']`) for namespaced elements. The parser uses `text/xml` mode so namespace declarations in the envelope are preserved.

---

## Assertion Chains — `apx.expect()`

`apx.expect(value)` returns a chainable assertion object. Methods and getters can be combined naturally:

```js
apx.expect(json.count).to.be.a('number').and.above(0);
apx.expect(json.items).to.have.lengthOf(3);
apx.expect(json.status).to.not.equal('deleted');
```

### Chainable Words (no-op)

These words exist purely for readability and can be inserted anywhere in a chain:

`to` · `be` · `been` · `is` · `that` · `which` · `and` · `has` · `have` · `with` · `at` · `of` · `same` · `does` · `still` · `also` · `deep`

### Boolean Getters

| Getter | Passes when |
|---|---|
| `.ok` | value is truthy (not `null`, `false`, `0`, or `""`) |
| `.true` | `value === true` |
| `.false` | `value === false` |
| `.null` | `value === null` |
| `.undefined` | `value === undefined` |
| `.NaN` | `Number.isNaN(value)` |
| `.exist` | `value != null` |
| `.empty` | `""`, `[]`, or `{}` with length/key count of 0 |

### Number Guards

| Getter | Passes when |
|---|---|
| `.positive` | `typeof value === 'number' && value > 0` |
| `.negative` | `typeof value === 'number' && value < 0` |
| `.integer` | `Number.isInteger(value)` |
| `.finite` | `Number.isFinite(value)` |

```js
apx.expect(json.count).to.be.positive;
apx.expect(json.offset).to.be.integer;
apx.expect(json.ratio).to.be.finite;
```

### Equality & Comparison

| Method | Aliases | Passes when |
|---|---|---|
| `.equal(v)` | `.equals(v)`, `.eq(v)` | `value === v` (strict equality) |
| `.eql(v)` | `.eqls(v)`, `.deep.equal(v)` | Deep equal via `JSON.stringify` |
| `.above(n)` | `.gt(n)`, `.greaterThan(n)` | `value > n` |
| `.below(n)` | `.lt(n)`, `.lessThan(n)` | `value < n` |
| `.least(n)` | `.gte(n)` | `value >= n` |
| `.most(n)` | `.lte(n)` | `value <= n` |
| `.within(lo, hi)` | — | `value >= lo && value <= hi` |
| `.closeTo(exp, delta)` | — | `Math.abs(value - exp) <= delta` |

```js
apx.expect(apx.response.responseTime).to.be.below(500);
apx.expect(json.score).to.be.within(0, 100);
apx.expect(json.pi).to.be.closeTo(3.14, 0.01);
```

### String Assertions

| Method | Passes when |
|---|---|
| `.include(s)` / `.contain(s)` | string contains `s` as a substring |
| `.startWith(s)` | string starts with `s` |
| `.endWith(s)` | string ends with `s` |
| `.match(regex)` | `regex.test(value)` |
| `.string(s)` | alias for `.include(s)` on strings |
| `.lengthOf(n)` | `value.length === n` |

```js
apx.expect(json.avatarUrl).to.startWith('https://');
apx.expect(json.filename).to.endWith('.pdf');
apx.expect(json.code).to.match(/^[A-Z]{3}-\d{4}$/);
```

### Array Assertions

| Method | Passes when |
|---|---|
| `.include(v)` | array contains element `v` (strict equality) |
| `.members(arr)` | both arrays contain the same elements (order-independent, deep) |
| `.includeMembers(arr)` | array is a superset of `arr` |
| `.oneOf(arr)` | **scalar** `value` is one of the elements in `arr` |
| `.everyItem(fn)` | all array elements pass predicate `fn(item)` |
| `.someItem(fn)` | at least one element passes predicate `fn(item)` |
| `.lengthOf(n)` | `value.length === n` |
| `.empty` | `value.length === 0` |

```js
apx.expect(json.roles).to.members(['admin', 'user', 'viewer']);    // exact set
apx.expect(json.roles).to.includeMembers(['admin']);               // superset
apx.expect(json.status).to.oneOf(['active', 'pending']);           // scalar
apx.expect(json.items).to.everyItem(i => i.id && i.name);         // all pass
apx.expect(json.tags).to.someItem(t => t === 'featured');          // any pass
```

### Object Assertions

| Method | Passes when |
|---|---|
| `.property(key, val?)` | key exists; optional value checked with `===` |
| `.deepProperty(path, val?)` | dot-path resolves (e.g. `'user.address.city'`); optional deep-equal value check |
| `.subset(obj)` | every own key in `obj` appears in `value` with matching value (recursive) |
| `.keys(arr)` / `.key(k)` | all listed keys exist in the object |
| `.eql(obj)` / `.deep.equal(obj)` | full deep equality |
| `.empty` | `Object.keys(value).length === 0` |

```js
apx.expect(json).to.have.property('id');
apx.expect(json).to.have.property('role', 'admin');

// Deep path — arrays via index: 'items.0.id'
apx.expect(json).to.deepProperty('user.address.city');
apx.expect(json).to.deepProperty('user.address.city', 'Paris');

// Partial match — extra keys in the response are allowed
apx.expect(json).to.subset({ status: 'active', role: 'user' });

apx.expect(json).to.have.keys(['id', 'email', 'role']);
```

### Type Assertions

| Method | Passes when |
|---|---|
| `.a(type)` / `.an(type)` | `typeof value === type` or `type === 'array'` + `Array.isArray(value)` |
| `.instanceOf(ctor)` | `value instanceof ctor` |

```js
apx.expect(json.count).to.be.a('number');
apx.expect(json.tags).to.be.an('array');
apx.expect(json.createdAt).to.be.an.instanceOf(Date);
```

### JSON Schema Validation

`.matchSchema(schema)` validates the value against a [JSON Schema](https://json-schema.org/) draft-7 object using `ajv`. Standard format keywords (`email`, `uri`, `date`, `uuid`, etc.) are also validated.

```js
apx.test("Response matches schema", () => {
  apx.expect(apx.response.json()).to.matchSchema({
    type: 'object',
    required: ['id', 'email'],
    properties: {
      id:    { type: 'integer' },
      email: { type: 'string', format: 'email' },
      role:  { type: 'string', enum: ['admin', 'user'] },
    },
    additionalProperties: false,
  });
});
```

The first schema violation is reported in the failure message with the instance path, e.g.:  
`Expected value to match schema: /email must match format "email"`

### Custom Predicate

`.satisfy(fn)` / `.satisfies(fn)` — calls `fn(value)` and asserts the return value is truthy.

```js
apx.expect(json.discount).to.satisfy(v => v >= 0 && v <= 100);
apx.expect(json.slug).to.satisfy(s => /^[a-z0-9-]+$/.test(s));
```

### Negation

Prepend `.not` anywhere in the chain to invert the immediately following assertion:

```js
apx.expect(json.error).to.not.exist;
apx.expect(json.status).to.not.equal('deleted');
apx.expect(json).to.not.subset({ hidden: true });
apx.expect(json).to.not.matchSchema({ type: 'string' });
```

`.not` applies to all methods and getters including `matchSchema`, `subset`, `deepProperty`, `members`, `oneOf`, and the boolean/number getters.

---

## Response Helpers

Sugar assertions applied directly on `apx.response` — no `apx.expect()` wrapper needed. These throw on failure and are therefore used inside `apx.test()` blocks.

```js
apx.test("Status OK",       () => apx.response.to.have.status(200));
apx.test("JSON body",       () => apx.response.to.have.jsonBody());
apx.test("Has token header",() => apx.response.to.have.header('X-Token'));
```

Full reference:

```js
apx.response.to.have.status(200);
apx.response.to.have.status(201);
apx.response.to.have.header('X-Token');
apx.response.to.have.header('Content-Type', 'application/json');  // check value too
apx.response.to.have.body('userId');       // body text includes the substring
apx.response.to.have.jsonBody();           // body is valid JSON
apx.response.to.be.ok();                   // status is 2xx
```

---

## Soft Assertions

By default, the first failing `apx.expect()` call throws immediately and stops the rest of the test body. **Soft assertions** collect all failures and report them together, so every check runs regardless.

```js
apx.test("All fields are valid", () => {
  const json = apx.response.json();

  apx.softExpect(json.id).to.be.positive;
  apx.softExpect(json.email).to.be.a('string');
  apx.softExpect(json.status).to.oneOf(['active', 'inactive']);

  // Must be called explicitly — flushes the buffer and throws a
  // single error listing all failures.
  apx.assertAll('field validation');
});
```

If all soft assertions passed, `apx.assertAll()` is a no-op. If any failed, it throws with a combined message:

```
field validation: 2 soft assertion(s) failed:
  - Expected "not-an-email" to be a string
  - Expected "suspended" to be one of ["active","inactive"]
```

> Soft assertion failures are scoped to the enclosing `apx.test()` block. Unflushed failures (because an earlier hard assertion threw before `apx.assertAll()` was reached) are discarded and do not affect subsequent tests.

---

## Skipping Tests

Mark a test as skipped without removing it from the script. Skipped tests appear in the results panel with a `~` indicator in muted/italic style and are **excluded from the pass/fail count** — they never turn the badge red.

```js
// Unconditional skip
apx.test.skip("Feature not yet released");

// Conditional skip based on environment
const isV2 = apx.environment.get('apiVersion') === 'v2';

if (isV2) {
  apx.test("New pagination cursor", () => {
    apx.expect(apx.response.json()).to.have.property('cursor');
  });
} else {
  apx.test.skip("New pagination cursor (v2 only)");
}
```

`apx.test.skip(name)` accepts an optional callback argument (for documentation purposes), but the callback is **never executed**.

---

## Variable Stores

All stores support the same interface:

| Method | Description |
|---|---|
| `.get(key)` | Read a value (returns `undefined` if absent) |
| `.set(key, value)` | Write a value (stored as string) |
| `.unset(key)` | Remove a key |
| `.has(key)` | Returns `true` if the key exists |
| `.clear()` | Remove all keys (namespaced stores only) |
| `.toObject()` | Snapshot as a plain JS object |

| Store | Scope | Notes |
|---|---|---|
| `apx.environment` | Active environment | Most commonly used for per-environment config |
| `apx.globals` | Global variables | Shared across all workspaces and environments |
| `apx.collection` / `apx.collectionVariables` | Collection-level | Scoped to the current collection |
| `apx.variables` | Generic | Routes to `collectionVariables` for unknown keys |
| `apx.iterationData` | Runner CSV row | **Read-only**: `.get()` and `.has()` only |

```js
// In a test script — extract a token and store it for subsequent requests
const json = apx.response.json();
apx.environment.set('accessToken', json.token);
apx.environment.set('userId',      String(json.user.id));

// In the next request's pre-request script — read it back
const token = apx.environment.get('accessToken');
```

See [Variables & Environments](Variables-and-Environments) for the full scope resolution hierarchy.

---

## Execution Control (Runner)

These methods only affect **Collection Runner** behaviour. They are no-ops when a request is sent individually.

| Method | Effect |
|---|---|
| `apx.execution.skipRequest()` | Skip the HTTP request for this item (pre-request script still runs) |
| `apx.execution.setNextRequest(name)` | Jump to a named request next, overriding sequential order |
| `apx.execution.setNextRequest(null)` | Stop the runner run after this request |

```js
// In a test script — abort the run if auth failed
apx.test("Auth check", () => {
  if (apx.response.code === 401) {
    console.error('Auth failed — stopping run');
    apx.execution.setNextRequest(null);
  }
  apx.response.to.have.status(200);
});
```

```js
// In a pre-request script — skip unauthenticated requests in a guest environment
if (!apx.environment.get('authToken')) {
  apx.execution.skipRequest();
}
```

See [Collection Runner](Collection-Runner) for full details on runner flow control.

---

## `apx.sendRequest()`

Make additional HTTP calls from within a script. This is useful for fetching tokens, looking up data, or hitting a setup/teardown endpoint.

```js
apx.sendRequest(
  {
    url: 'https://api.example.com/token',
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    body: {
      mode: 'raw',
      raw: JSON.stringify({
        grant_type: 'client_credentials',
        client_id:     apx.environment.get('clientId'),
        client_secret: apx.environment.get('clientSecret'),
      }),
    },
  },
  (err, response) => {
    if (err) {
      console.error('Token request failed:', err);
      return;
    }
    apx.environment.set('accessToken', response.json().access_token);
  }
);
```

**Request object fields:**

| Field | Type | Description |
|---|---|---|
| `url` | `string` | Full URL including query string |
| `method` | `string` | HTTP method (`GET`, `POST`, etc.) |
| `header` | `Array<{key, value}>` | Request headers |
| `body.mode` | `'raw' \| 'urlencoded' \| 'formdata'` | Body encoding |
| `body.raw` | `string` | Raw string body (JSON, text, etc.) |
| `body.urlencoded` | `Array<{key, value}>` | URL-encoded form fields |

The callback receives `(err, response)` where `response` exposes the same interface as `apx.response` (`.json()`, `.text()`, `.code`, `.headers`, etc.).

> `apx.sendRequest()` in a **pre-request script** executes before the main request is sent; the callback must complete before the main request fires.

---

## Modifying the Request from a Script

A pre-request script can add or overwrite headers on the outgoing request using `apx.request.headers.upsert()`:

```js
// Inject a correlation ID
apx.request.headers.upsert({
  key:   'X-Correlation-Id',
  value: apx.environment.get('uuid') ?? crypto.randomUUID(),
});

// Set a dynamic authorization header
const token = apx.environment.get('accessToken');
if (!token) throw new Error('accessToken is not set');
apx.request.headers.upsert({ key: 'Authorization', value: `Bearer ${token}` });
```

---

## Console Output

All four standard console methods are available. Output appears in the **Console** panel (bottom of the UI) grouped per request, with level badges.

```js
console.log('Response time:', apx.response.responseTime, 'ms');
console.info('Token stored:', apx.environment.get('accessToken'));
console.warn('Missing optional field — id:', json.id);
console.error('Unexpected status:', apx.response.code);
```

The Console panel supports pop-out mode and preserves the full log history for the session.

![Console panel with script output](images/scripting-console.png)

---

## Test Results Display

After a request completes, the **Tests** tab shows results for all `apx.test()` blocks.

| Indicator | Meaning |
|---|---|
| `✓` green | Test passed |
| `✗` red | Test failed — error message shown inline |
| `~` grey italic | Test skipped via `apx.test.skip()` |

The **tab label** uses the format `Tests (passed/total +skipped)` — e.g. `Tests (4/5 +1)`.

The **status bar badge** shows `Tests: 4/5 passed (1 skipped)` and turns red only when `failed > 0`.

![Test results in the Tests tab](images/scripting-test-results.png)

---

## Snippet Library

Click the **Snippets** button in the script editor to open the Snippet Library. Select any snippet to insert it at the cursor.

![Snippet Library panel](images/scripting-snippets-library.png)

**Pre-request snippet categories:**

| Category | Snippets |
|---|---|
| **Variables & Environment** | Inject Timestamp, Generate UUID, Random Integer, ISO Date String |
| **Hashing & Encoding** | Base64 Encode, Base64 Decode, HMAC-SHA256 Signature, MD5 Hash |
| **Authentication** | Generate JWT (HS256), Set Bearer from Env, Basic Auth Header, API Key Header |
| **Apilix Functions** | Get/Set/Unset env, Get/Set global, Get/Set collection variable, `apx.sendRequest()`, Add/Upsert header, Console log |

**Test snippet categories:**

| Category | Snippets |
|---|---|
| **Status Code** | Status is 200, Status is 2xx, Status is 201 Created |
| **Response Time** | < 500ms, < 1s |
| **JSON Body** | Response is JSON, Property exists, Property equals value, Array not empty, Store value from response |
| **Apilix Functions** | Get/Set/Unset env, Parse JSON, Get text, Skip request, Set next request |
| **Headers** | Content-Type is JSON, Header exists, Store header value |
| **Advanced Assertions** | JSON Schema validation, Partial object match, Deep property check, Array has exact members, Array includes members, Value is one of, Every array item satisfies predicate, Custom predicate assertion, Number type guards, String starts/ends with, Soft assertions block |
| **Test Control** | Skip a test, Conditionally skip test |
| **XML / SOAP Responses** | Parse XML with XPath, Extract XML value (one-liner), Extract all XML values |

---

## Common Patterns

### Pattern 1 — Capture a Token After Login

A common workflow: log in, capture the token, use it in all subsequent requests.

**POST /auth/login — test script:**

```js
apx.test("Login succeeded", () => {
  apx.response.to.have.status(200);
  apx.response.to.have.jsonBody();
});

const json = apx.response.json();
apx.environment.set('accessToken', json.token);
apx.environment.set('userId', String(json.user.id));
console.log('Token captured and stored');
```

All requests that use `Bearer {{accessToken}}` will automatically pick up the stored token.

---

### Pattern 2 — Fetch a Fresh Token Lazily

Fetch a token only when one is not already in the environment. Runs in the pre-request script of each protected request (or at the collection level).

```js
// Pre-request script
const token = apx.environment.get('accessToken');

if (!token) {
  await new Promise((resolve, reject) => {
    apx.sendRequest(
      {
        url: apx.environment.get('tokenUrl'),
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
        body: {
          mode: 'urlencoded',
          urlencoded: [
            { key: 'grant_type',    value: 'client_credentials' },
            { key: 'client_id',     value: apx.environment.get('clientId') },
            { key: 'client_secret', value: apx.environment.get('clientSecret') },
          ],
        },
      },
      (err, res) => {
        if (err) return reject(err);
        apx.environment.set('accessToken', res.json().access_token);
        resolve();
      }
    );
  });
}
```

---

### Pattern 3 — Controlled Runner Flow

Branch the run based on an environment flag or previous response.

```js
// Test script — redirect the runner based on feature flag
const useV2 = apx.environment.get('apiVersion') === 'v2';
apx.execution.setNextRequest(useV2 ? 'GET /v2/users' : 'GET /v1/users');
```

```js
// Test script — stop the run early on auth failure
if (apx.response.code === 401) {
  console.error('Unexpected 401 — stopping run');
  apx.execution.setNextRequest(null);
}
```

---

### Pattern 4 — JSON Schema Contract Test

Validate that a response matches the agreed API contract on every run:

```js
apx.test("GET /users/:id — schema v2", () => {
  apx.expect(apx.response.json()).to.matchSchema({
    type: 'object',
    required: ['id', 'email', 'role', 'createdAt'],
    properties: {
      id:        { type: 'integer', minimum: 1 },
      email:     { type: 'string', format: 'email' },
      role:      { type: 'string', enum: ['admin', 'user', 'viewer'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
    additionalProperties: false,
  });
});
```

---

### Pattern 5 — Data-driven Soft Assertions

Run all checks and get a single combined failure report instead of stopping at the first error:

```js
apx.test("Full response validation", () => {
  const json = apx.response.json();

  apx.softExpect(apx.response.code).to.equal(200);
  apx.softExpect(json.id).to.be.a('number').and.positive;
  apx.softExpect(json.email).to.match(/.+@.+\..+/);
  apx.softExpect(json.role).to.oneOf(['admin', 'user', 'viewer']);
  apx.softExpect(json.createdAt).to.be.a('string');

  apx.assertAll('user object validation');
});
```

---

### Pattern 6 — Parse a SOAP Response

Extract a security token returned inside a SOAP envelope and store it for subsequent requests.

**POST /auth/soap — test script:**

```js
apx.test("SOAP login succeeded", () => {
  apx.response.to.have.status(200);
});

// Parse the SOAP envelope and extract the token
const token = apx.response.xmlPath('//token');
if (!token) {
  console.error('Token not found in SOAP response');
} else {
  apx.environment.set('authToken', token);
  console.log('Token captured from SOAP response');
}
```

For responses with XML namespaces, use the `xpath` global with a namespace-agnostic predicate:

```js
const doc = apx.response.xml();
const node = xpath.select1('//*[local-name()="SessionToken"]', doc);
if (node) {
  apx.environment.set('sessionToken', node.textContent || node.nodeValue || '');
}
```

---

## See Also

- [Variables & Environments](Variables-and-Environments) — variable stores and scope hierarchy
- [Authentication](Authentication) — `apx.sendRequest()` for scripted token flows
- [Collection Runner](Collection-Runner) — `apx.execution.setNextRequest()` and CSV iteration data
- [Collections & Requests](Collections-and-Requests) — where scripts are attached (collection, folder, request)
