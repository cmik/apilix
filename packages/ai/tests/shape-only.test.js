'use strict';

// Shape-only mode (sendResponseBodies=false): no value of the request or the response may leave.
// Every test captures what the fake provider receives and checks the WHOLE payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestAssertions, buildData } = require('../src/assert-suggest');
const { explainFailure } = require('../src/explain-failure');
const { describeDocs, collectEntries } = require('../src/doc-describe');
const { buildPreviewContext } = require('../src/context');
const { shapeHeaders, shapeUrl, shapeOfText, buildShapeSchema, extractTestTitles, SAFE_HEADER_VALUES } = require('../src/shape');
const { buildDocModel } = require('@apilix/core/docs');

const fake = (answer, calls = []) => ({
  calls,
  complete: async (req) => { calls.push(req); return { data: answer, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', latencyMs: 1 }; },
});
const EXPLAIN = { summary: 's', likelyCauses: [], suggestedFixes: [] };
const FAILURES = [{ name: 'x', error: 'bad' }];

async function payloadOf(kind, input, shapeOnly = true) {
  const calls = [];
  if (kind === 'suggest') await suggestAssertions({ provider: fake({ suggestions: [] }, calls), ...input, sendResponseBodies: !shapeOnly });
  else await explainFailure({ provider: fake(EXPLAIN, calls), failures: FAILURES, ...input, sendResponseBodies: !shapeOnly });
  return JSON.stringify(calls[0]);
}
/** The data object the model receives (the JSON inside the untrusted_data block). */
function dataOf(sent) {
  const user = JSON.parse(sent).messages[0].content;
  return JSON.parse(user.slice(user.indexOf('<untrusted_data>') + 16, user.indexOf('</untrusted_data>')));
}
const RES = { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{}' };

// ── 1. prototype-named headers ───────────────────────────────────────────────
const EVIL = JSON.parse('{"constructor":"TOPSECRETVALUE","__proto__":"TOPSECRETVALUE","toString":"TOPSECRETVALUE","hasOwnProperty":"TOPSECRETVALUE","valueOf":"TOPSECRETVALUE"}');

for (const kind of ['suggest', 'explain']) {
  for (const shapeOnly of [true, false]) {
    test(`${kind}, ${shapeOnly ? 'shape-only' : 'full'}: prototype-named headers neither throw nor leak (request and response)`, async () => {
      const request = { method: 'GET', url: 'https://h.test/x', header: Object.keys(EVIL).map(k => ({ key: k, value: 'TOPSECRETVALUE' })) };
      const sent = await payloadOf(kind, { request, response: { ...RES, headers: EVIL } }, shapeOnly);
      if (shapeOnly) {
        assert.ok(!sent.includes('TOPSECRETVALUE'), 'leaked a header value');
        for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.ok(sent.includes(n), `missing name ${n}`);
      }
    });
  }
}

test('shapeHeaders: inherited allowlist members are not found; __proto__ is plain data', () => {
  for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = shapeHeaders([[k, 'TOPSECRETVALUE']]);
    assert.deepEqual(r.names, [k]);
    assert.deepEqual(Object.keys(r.values), []);
  }
  assert.equal(Object.getPrototypeOf(SAFE_HEADER_VALUES), null);
  assert.equal({}.polluted, undefined);
});

test('preview of prototype-named headers does not throw and does not leak', () => {
  const item = { name: 'r', request: { method: 'GET', url: 'https://h.test/', header: [{ key: '__proto__', value: 'TOPSECRETVALUE' }, { key: 'constructor', value: 'TOPSECRETVALUE' }] } };
  const text = JSON.stringify(buildPreviewContext({ item, response: { ...RES, headers: EVIL }, settings: { sendResponseBodies: false } }).sections);
  assert.ok(!text.includes('TOPSECRETVALUE'));
});

// ── 2. real allowlists ───────────────────────────────────────────────────────
const one = (name, value) => shapeHeaders([[name, value]]).values[name];

test('cache-control keeps only known directives', () => {
  assert.equal(one('cache-control', 'secret_token_abc'), undefined);
  assert.equal(one('cache-control', 'private-tenant=acme'), undefined);
  assert.equal(one('cache-control', 'no-cache, private-tenant=acme, MAX-AGE=60'), 'no-cache, MAX-AGE=60');
  assert.equal(one('cache-control', 'public, max-age=3600, s-maxage=10, stale-while-revalidate=5, stale-if-error=9, immutable'), 'public, max-age=3600, s-maxage=10, stale-while-revalidate=5, stale-if-error=9, immutable');
  assert.equal(one('cache-control', 'max-age=abc'), undefined);
});

test('content-encoding keeps coding tokens only', () => {
  assert.equal(one('content-encoding', 'secret_token_abc'), undefined);
  assert.equal(one('content-encoding', 'gzip, br'), 'gzip, br');
  assert.equal(one('content-encoding', 'gzip, tenant42'), 'gzip');
});

test('content-type drops boundary and extra parameters; arrays and duplicates are deterministic', () => {
  assert.equal(one('content-type', 'multipart/form-data; boundary=SECRETBOUNDARY'), 'multipart/form-data');
  assert.equal(one('content-type', 'text/plain; charset=utf-8; token=abc'), 'text/plain; charset=utf-8');
  assert.equal(one('content-type', ['application/json', 'text/x-secret']), undefined);
  const dup = shapeHeaders([['Content-Type', 'application/json'], ['content-type', 'text/plain'], ['X-A', '1'], ['x-a', '2']]);
  assert.deepEqual(dup.names, ['Content-Type', 'X-A']);
  assert.deepEqual({ ...dup.values }, { 'Content-Type': 'application/json' });
});

// ── 3. names that carry values ───────────────────────────────────────────────
test('value-like header names become <other> once; plain names stay', () => {
  const r = shapeHeaders([['X-User-alice@example.com', 'v'], ['X-Tenant-bob@corp.io', 'v'], ['x'.repeat(65), 'v'], ['Accept', 'v'], ['bad name', 'v'], ['X-Trace-1234567890', 'v']]);
  assert.deepEqual(r.names, ['<other>', 'Accept']);
});

test('shape-only payload never carries an email-bearing header name (request and response)', async () => {
  const request = { method: 'GET', url: 'https://h.test/', header: [{ key: 'X-User-alice@example.com', value: 'v' }] };
  const sent = await payloadOf('suggest', { request, response: { ...RES, headers: { 'X-User-bob@example.com': 'v' } } });
  assert.ok(!sent.includes('alice') && !sent.includes('bob'));
  assert.ok(sent.includes('<other>'));
});

// ── 4. request side in shape-only ────────────────────────────────────────────
const REQ = {
  method: 'POST',
  url: 'https://user:pw@h.com/users/12345/orders?email=alice@example.com&q=hello%20world#frag-secret',
  header: [{ key: 'Content-Type', value: 'application/json' }],
  body: { mode: 'raw', raw: '{"email":"alice@example.com","ssn":"123-45-6789"}' },
};
const REQ_VALUES = ['alice', 'example.com', '12345', 'hello', 'world', '123-45-6789', 'user:pw', 'frag-secret', 'jo@corp.com'];
const EXISTING = 'apx.test("User jo@corp.com has id 42", () => { const json = apx.response.json(); expect(json.email).to.equal("jo@corp.com"); });\npm.test(\'second\', () => {});';

for (const kind of ['suggest', 'explain']) {
  test(`${kind}, shape-only: request URL, body and name carry no value; names and shape do`, async () => {
    const sent = await payloadOf(kind, { request: REQ, name: 'Get alice@example.com', response: RES, existingTests: EXISTING, testScript: EXISTING });
    for (const v of REQ_VALUES) assert.ok(!sent.includes(v), `leaked ${v}`);
    const req = dataOf(sent).request;
    assert.equal(req.url, 'https://h.com/users/:id/orders?email=<value>&q=<value>');
    assert.deepEqual(req.body, { email: 'string', ssn: 'string' });
    assert.equal(req.name, 'Get <string>');
  });

  test(`${kind}, normal mode: request URL, body and name are unchanged`, async () => {
    const sent = await payloadOf(kind, { request: REQ, name: 'Get alice@example.com', response: RES, redactSecrets: false }, false);
    for (const v of ['12345', 'email=alice@example.com', 'Get alice@example.com', '123-45-6789']) assert.ok(sent.includes(v), `lost ${v}`);
  });
}

test('assert-suggest shape-only: existing tests are titles only, never bodies', async () => {
  const sent = await payloadOf('suggest', { request: REQ, response: RES, existingTests: EXISTING });
  const data = dataOf(sent);
  assert.ok(!sent.includes('jo@corp.com'));
  assert.ok(!JSON.stringify(data).includes('expect(') && !JSON.stringify(data).includes('.to.equal'));
  assert.deepEqual(data.existingTestTitles, ['User <string> has id <number>', 'second']);
  assert.equal('existingTests' in data, false);
  const full = await payloadOf('suggest', { request: REQ, response: RES, existingTests: EXISTING }, false);
  assert.ok(dataOf(full).existingTests.includes('.to.equal'));
});

test('shapeUrl: scheme+host+path kept, ids replaced, query values and userinfo dropped', () => {
  assert.equal(shapeUrl('https://u:p@h.com/users/12345/orders?email=a@b.c&q=x'), 'https://h.com/users/:id/orders?email=<value>&q=<value>');
  assert.equal(shapeUrl('https://h.com/a/123e4567-e89b-12d3-a456-426614174000/b/deadbeefdeadbeefdeadbeef/c/alice@x.io'), 'https://h.com/a/:id/b/:id/c/:id');
  assert.equal(shapeUrl('{{baseUrl}}/users/{{id}}/v1?k={{k}}'), '{{baseUrl}}/users/{{id}}/v1?k=<value>');
  assert.equal(shapeUrl('https://h.com/x?alice@example.com'), 'https://h.com/x?<other>');
});

test('request body shapes: form fields as names, non-JSON text as length', async () => {
  const form = { method: 'POST', url: 'https://h.test/', body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'alice' }, { key: 'pw', value: 'hunter22' }] } };
  const a = await payloadOf('suggest', { request: form, response: RES });
  assert.ok(!a.includes('alice') && !a.includes('hunter22'));
  assert.deepEqual(dataOf(a).request.body, ['user', 'pw']);
  const text = { method: 'POST', url: 'https://h.test/', body: { mode: 'raw', raw: 'plain secret words' } };
  const b = await payloadOf('suggest', { request: text, response: RES });
  assert.ok(!b.includes('secret words'));
  assert.deepEqual(dataOf(b).request.body, { type: 'text', length: 18 });
});

test('name masking is linear-time on hostile input and keeps the 200-char clip', async () => {
  const hostile = `${"'".repeat(50000)}${'a@'.repeat(50000)}`;
  const t0 = Date.now();
  const sent = await payloadOf('suggest', { request: REQ, name: hostile, response: RES });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(sent.length < 20000);
});

test('statusText is masked in shape-only mode', async () => {
  const sent = await payloadOf('explain', { request: REQ, response: { ...RES, statusText: "Bad 'alice@example.com' 4242" } });
  assert.ok(!sent.includes('alice') && !sent.includes('4242'));
});

test('extractTestTitles reads apx.test / pm.test titles only', () => {
  assert.deepEqual(extractTestTitles('apx.test( "a b", () => { x("secret") }); apx.test(notAString, f); pm.test(`c 12`, f)'), ['a b', 'c <number>']);
  assert.deepEqual(extractTestTitles(undefined), []);
});

// ── 5. preview == payload ─────────────────────────────────────────────────────
function payloadFields(shapeOnly, opts = {}) {
  const input = { request: REQ, name: 'Get alice@example.com', response: { ...RES, responseTime: 12, statusText: 'OK 200' }, existingTests: EXISTING, redactSecrets: false, ...opts };
  const { text } = buildData({ ...input, sendResponseBodies: !shapeOnly, bodyTokens: 5000, includeExisting: true });
  const data = JSON.parse(text);
  const preview = buildPreviewContext({
    item: { name: input.name, request: REQ, event: [{ listen: 'test', script: { exec: EXISTING.split('\n') } }, { listen: 'prerequest', script: { exec: ['const SECRETPRE = 1;'] } }] },
    response: input.response,
    settings: { sendResponseBodies: !shapeOnly, redactSecrets: false, maxContextTokens: 100000 },
  });
  return { data, sections: Object.fromEntries(preview.sections.map(s => [s.label, s.text])) };
}

for (const shapeOnly of [true, false]) {
  test(`assert-suggest preview equals payload (${shapeOnly ? 'shape-only' : 'full'}): request, response head, existing tests`, () => {
    const { data, sections } = payloadFields(shapeOnly);
    assert.deepEqual(JSON.parse(sections.Request), data.request);
    assert.deepEqual(JSON.parse(sections['Response (status and headers)']), { status: data.response.status, statusText: data.response.statusText, headers: data.response.headers, responseTimeMs: data.response.responseTimeMs });
    if (shapeOnly) {
      assert.deepEqual(JSON.parse(sections['Existing tests (titles only)']), data.existingTestTitles);
      assert.deepEqual(JSON.parse(sections['Response body (shape only)']), data.response.bodyShape);
    } else {
      assert.equal(sections['Test script'], data.existingTests);
    }
    assert.ok(!Object.values(sections).join('').includes('SECRETPRE'), 'pre-request script is not sent, so not shown');
  });
}

test('preview request section omits auth and description exactly like the payload', () => {
  const request = { ...REQ, description: 'DESCRIPTIONTEXT', auth: { type: 'bearer', bearer: [{ key: 'token', value: 'plain' }] } };
  const sections = buildPreviewContext({ item: { request }, settings: { sendResponseBodies: true, redactSecrets: false } }).sections;
  const text = sections.map(s => s.text).join('');
  assert.ok(!text.includes('DESCRIPTIONTEXT') && !text.includes('bearer'));
});

// ── 6/7. doc-describe ─────────────────────────────────────────────────────────
function docCollection(over = {}) {
  return {
    info: { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{
      name: 'Get alice',
      request: {
        method: 'POST',
        url: { raw: 'https://h.test/users/12345?email=alice@example.com', host: ['h', 'test'], path: ['users', '12345'], query: [{ key: 'email', value: 'alice@example.com' }] },
        header: [{ key: 'X-Tenant', value: 'tenant-acme' }],
        body: { mode: 'raw', raw: '{"email":"alice@example.com"}' },
      },
      response: over.response || [],
    }],
  };
}

test('doc-describe shape-only: parameter examples, body and URL carry no value', () => {
  const m = buildDocModel(docCollection(), { includeExamples: true });
  const shape = JSON.stringify(collectEntries(m, [], { skipped: 0 }, { shapeOnly: true }));
  for (const v of ['alice@example.com', '12345', 'tenant-acme']) assert.ok(!shape.includes(v), `leaked ${v}`);
  assert.match(shape, /"email":"string"/);
  assert.match(shape, /:id/);
  assert.ok(!shape.includes('"example"'));
  const full = JSON.stringify(collectEntries(m, [], { skipped: 0 }, { shapeOnly: false }));
  assert.ok(full.includes('"example"') && full.includes('12345'));
});

test('describeDocs passes sendResponseBodies through and applies it to what the provider receives', async () => {
  const m = buildDocModel(docCollection({ response: [{ name: 'ok', code: 200, body: '{"ssn":"123-45-6789"}' }] }), { includeExamples: true });
  for (const [flag, expectLeak] of [[false, false], [true, true]]) {
    const calls = [];
    await describeDocs({ provider: fake({ items: [] }, calls), model: m, sendResponseBodies: flag });
    const sent = JSON.stringify(calls[0]);
    assert.equal(sent.includes('123-45-6789'), expectLeak);
    assert.equal(sent.includes('alice@example.com'), expectLeak);
  }
});

test('exampleShape: non-JSON, non-string, array, empty and circular example bodies never throw', () => {
  const circular = {}; circular.self = circular;
  const bodies = ['plain text', 42, [1, 2], '', undefined, '[]', circular];
  for (const body of bodies) {
    const col = docCollection({ response: [{ name: 'ok', code: 200, body }] });
    const m = buildDocModel(col, { includeExamples: true });
    m.requests[0].examples = [{ status: 200, code: 200, body: body === undefined ? 'x' : body }];
    assert.doesNotThrow(() => collectEntries(m, [], { skipped: 0 }, { shapeOnly: true }), String(body));
  }
  const m = buildDocModel(docCollection(), { includeExamples: true });
  m.requests[0].examples = [{ status: 200, body: [1, 2] }];
  assert.deepEqual(collectEntries(m, [], { skipped: 0 }, { shapeOnly: true }).find(e => e.exampleResponse).exampleResponse.bodyShape, ['number']);
  m.requests[0].examples = [{ status: 200, body: 'plain' }];
  assert.deepEqual(collectEntries(m, [], { skipped: 0 }, { shapeOnly: true }).find(e => e.exampleResponse).exampleResponse.bodyShape, { type: 'text', length: 5 });
  m.requests[0].examples = [{ status: 200, body: circular }];
  assert.deepEqual(collectEntries(m, [], { skipped: 0 }, { shapeOnly: true }).find(e => e.exampleResponse).exampleResponse.bodyShape, { type: 'text', length: 0 });
});

test('shapes cap the number of object keys with a marker', () => {
  const big = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
  const s = buildShapeSchema(big);
  assert.equal(Object.keys(s).length, 51);
  assert.equal(s['…'], '…');
  assert.equal(Object.keys(shapeOfText(JSON.stringify(big))).length, 51);
  const parsed = JSON.parse('{"__proto__":{"a":1}}');
  assert.deepEqual(Object.keys(buildShapeSchema(parsed)), ['__proto__']);
  assert.equal({}.a, undefined);
});
