'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDocModel } = require('@apilix/core/docs');
const { describeDocs, collectEntries, buildBatches, sanitizeAnswer } = require('../src/doc-describe');
const { AiError } = require('../src/errors');

const SECRET = 'S3CR3T-env-value-99';
const collection = () => ({
  info: { name: 'Shop', description: '' },
  item: [
    {
      id: 'f1', name: 'Orders',
      item: [
        { id: 'r1', name: 'List orders', request: { method: 'GET', url: { raw: 'https://api.test/orders?limit=10&api_key=abc123', query: [{ key: 'limit', value: '10' }, { key: 'api_key', value: 'abc123' }] }, header: [{ key: 'Authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc' }, { key: 'X-Trace', value: 'trace-1' }, { key: 'Content-Type', value: 'application/json' }] } },
        { id: 'r2', name: 'Create', request: { method: 'POST', description: 'Already documented', url: 'https://api.test/orders', body: { mode: 'raw', raw: `{"note":"${SECRET}"}` } } },
        { id: 'r3', name: 'Fully documented', request: { method: 'GET', description: 'Has text', url: 'https://api.test/x' } },
      ],
    },
  ],
});
const model = () => buildDocModel(collection(), {});
const fakeProvider = (answer, calls = []) => ({
  calls,
  complete: async (req) => { calls.push(req); return { data: typeof answer === 'function' ? answer(req, calls.length) : answer, usage: { inputTokens: 10, outputTokens: 5 } }; },
});

test('collects only entries with something to document', () => {
  const ids = collectEntries(model()).map(e => e.id);
  assert.ok(ids.includes('__collection__'));
  assert.ok(ids.includes('f1'));
  assert.ok(ids.includes('r1'));
  assert.ok(!ids.includes('r2'), 'r2 already has a description and no undocumented params');
});

test('requests with description and no undocumented params are skipped', () => {
  const ids = collectEntries(model()).map(e => e.id);
  assert.ok(!ids.includes('r3'));
});

test('skipped standard headers; Authorization/api_key values never reach the batch text', () => {
  const entries = collectEntries(model());
  const r1 = entries.find(e => e.id === 'r1');
  const names = r1.params.map(p => p.name);
  assert.ok(names.includes('limit') && names.includes('X-Trace'));
  assert.ok(!names.includes('Authorization') && !names.includes('Content-Type'));
  const text = JSON.stringify(buildBatches(entries, { secretValues: [SECRET] }));
  assert.ok(!text.includes('abc123'));
  assert.ok(!text.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(!text.includes(SECRET), 'known secret values are scrubbed from body text');
});

test('batches respect the entry cap and the token budget', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, kind: 'request', name: `n${i}`, url: `https://x/${'y'.repeat(200)}` }));
  const b = buildBatches(many, { maxContextTokens: 100000 });
  assert.ok(b.length >= 3 && b.every(x => x.length <= 25));
  const tiny = buildBatches(many, { maxContextTokens: 1600 });
  assert.ok(tiny.length > b.length);
});

test('describeDocs returns descriptions keyed by id and never overrides existing text', async () => {
  const provider = fakeProvider({
    items: [
      { id: 'r1', description: 'Lists orders.', params: [{ name: 'limit', description: 'Max rows.' }, { name: 'ghost', description: 'not asked' }] },
      { id: 'r2', description: 'must be dropped, already documented' },
      { id: 'nope', description: 'unknown id' },
      { id: 'f1', description: '  Order  endpoints.  ' },
    ],
  });
  const r = await describeDocs({ provider, model: model(), language: 'fr' });
  assert.equal(r.descriptions.r1.description, 'Lists orders.');
  assert.deepEqual(r.descriptions.r1.params, { 'query:limit': 'Max rows.' });
  assert.equal(r.descriptions.r2, undefined);
  assert.equal(r.descriptions.nope, undefined);
  assert.equal(r.descriptions.f1.description, 'Order endpoints.');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 });
  assert.match(provider.calls[0].system, /fr/);
  assert.match(provider.calls[0].messages[0].content, /<untrusted_data>/);
  assert.equal(provider.calls[0].schema, 'docDescribe');
});

test('nothing to describe → no provider call', async () => {
  const m = buildDocModel({ info: { name: 'X', description: 'd' }, item: [{ id: 'a', name: 'a', request: { method: 'GET', description: 'x', url: 'https://x' } }] }, {});
  const provider = fakeProvider({ items: [] });
  const r = await describeDocs({ provider, model: m });
  assert.equal(provider.calls.length, 0);
  assert.equal(r.requested, 0);
});

test('a failing batch becomes a warning, other batches survive; AUTH aborts', async () => {
  const many = { info: { name: 'Big', description: 'd' }, item: Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, name: `q${i}`, request: { method: 'GET', url: `https://x/${i}` } })) };
  const failFirst = fakeProvider((_req, n) => { if (n === 1) throw new AiError('INVALID_OUTPUT', 'bad'); return { items: [{ id: 'q29', description: 'ok' }] }; });
  const r = await describeDocs({ provider: failFirst, model: buildDocModel(many, {}) });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.descriptions.q29.description, 'ok');
  const auth = { complete: async () => { throw new AiError('AUTH', 'no'); } };
  await assert.rejects(describeDocs({ provider: auth, model: model() }), e => e.code === 'AUTH');
});

test('sanitizeAnswer caps description length', () => {
  const out = sanitizeAnswer([{ id: 'a' }], [{ id: 'a', description: 'x'.repeat(2000) }]);
  assert.equal(out.a.description.length, 400);
});

test('same parameter name in different places keeps its own description (in:name keys)', () => {
  const batch = [{ id: 'r', params: [{ name: 'id', in: 'path' }, { name: 'id', in: 'query' }, { name: 'page', in: 'query' }] }];
  const out = sanitizeAnswer(batch, [{ id: 'r', params: [
    { in: 'path', name: 'id', description: 'Order id.' },
    { in: 'query', name: 'id', description: 'Filter by id.' },
    { name: 'page', description: 'Page number.' },   // "in" omitted but unambiguous
    { name: 'id', description: 'ambiguous: dropped' },
    { in: 'body', name: 'id', description: 'not asked: dropped' },
  ] }]);
  assert.deepEqual(out.r.params, { 'path:id': 'Order id.', 'query:id': 'Filter by id.', 'query:page': 'Page number.' });
});

test('items sharing an id are skipped with a warning instead of receiving the same text', async () => {
  const dup = { info: { name: 'D', description: 'd' }, item: [
    { id: 'dup', name: 'A', request: { method: 'GET', url: 'https://x/a' } },
    { id: 'dup', name: 'B', request: { method: 'GET', url: 'https://x/b' } },
    { id: 'ok', name: 'C', request: { method: 'GET', url: 'https://x/c' } },
  ] };
  const provider = fakeProvider({ items: [{ id: 'dup', description: 'ambiguous' }, { id: 'ok', description: 'fine' }] });
  const r = await describeDocs({ provider, model: buildDocModel(dup, {}) });
  assert.equal(r.descriptions.dup, undefined);
  assert.equal(r.descriptions.ok.description, 'fine');
  assert.equal(r.requested, 1);
  assert.match(r.warnings.join(' '), /shared by several items/);
  assert.ok(!provider.calls[0].messages[0].content.includes('"https://x/a"'));
});

test('a single huge request is trimmed: no entry can blow the token budget', async () => {
  const fields = Array.from({ length: 600 }, (_, i) => ({ key: `field${i}`, value: 'v'.repeat(500), type: 'text' }));
  const huge = { info: { name: 'H', description: 'd' }, item: [
    { id: 'big', name: 'N'.repeat(5000), request: { method: 'POST', url: `https://x/${'u'.repeat(100000)}`, body: { mode: 'formdata', formdata: fields } } },
  ] };
  const warnings = [];
  const entries = collectEntries(buildDocModel(huge, {}), warnings);
  const big = entries.find(e => e.id === 'big');
  assert.ok(big.name.length <= 201 && big.url.length <= 301);
  assert.equal(big.params.length, 40);
  assert.ok(big.params.every(p => !p.example || p.example.length <= 81));
  assert.match(warnings.join(' '), /only the first 40/);
  const { estimateTokens } = require('../src/budget');
  const maxContextTokens = 8000;
  const batches = buildBatches(entries, { maxContextTokens });
  for (const b of batches) assert.ok(estimateTokens(JSON.stringify(b, null, 1)) <= maxContextTokens - 1500);
});

test('an entry that cannot fit even after trimming is skipped with a warning', () => {
  const entries = [{ id: 'a', kind: 'request', name: 'a', params: Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, in: 'query', example: 'x'.repeat(80) })) }];
  const warnings = [];
  const batches = buildBatches(entries, { maxContextTokens: 100, warnings });
  assert.deepEqual(batches, []);
  assert.match(warnings.join(' '), /too large/);
});

const manyReq = (n) => ({ info: { name: 'Big', description: 'd' }, item: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, name: `q${i}`, request: { method: 'GET', url: `https://x/${i}` } })) });

test('RATE_LIMIT stops the run instead of calling the provider for every remaining batch', async () => {
  const provider = fakeProvider((_req, n) => { if (n === 2) throw new AiError('RATE_LIMIT', 'slow down'); return { items: [{ id: 'q0', description: 'kept' }] }; });
  const r = await describeDocs({ provider, model: buildDocModel(manyReq(100), {}) });
  assert.equal(provider.calls.length, 2);
  assert.equal(r.descriptions.q0.description, 'kept', 'batches done before the failure are kept');
  assert.match(r.warnings.join(' '), /rate limit/);
  assert.match(r.warnings.join(' '), /remaining batch/);
});

test('two consecutive failures stop the run; a success in between resets the counter', async () => {
  const bad = fakeProvider(() => { throw new AiError('TIMEOUT', 't'); });
  const r = await describeDocs({ provider: bad, model: buildDocModel(manyReq(100), {}) });
  assert.equal(bad.calls.length, 2);
  assert.match(r.warnings.join(' '), /2 consecutive failures/);

  const flaky = fakeProvider((_req, n) => { if (n % 2 === 1) throw new AiError('TIMEOUT', 't'); return { items: [] }; });
  const r2 = await describeDocs({ provider: flaky, model: buildDocModel(manyReq(100), {}) });
  assert.ok(flaky.calls.length > 2, 'alternating failures never reach 2 in a row');
  assert.ok(!/consecutive/.test(r2.warnings.join(' ')));
});

test('sanitizeAnswer strips images, links and URLs from model text (exfiltration channel)', () => {
  const out = sanitizeAnswer([{ id: 'a', params: [{ name: 'q', in: 'query' }] }], [
    { id: 'a', description: 'Hi ![t](https://evil.test/p.png?d=orders) <img src=x> there', params: [{ in: 'query', name: 'q', description: 'See [here](https://evil.test) https://evil.test/z' }] },
  ]);
  assert.equal(out.a.description, 'Hi t there');
  assert.equal(out.a.params['query:q'], 'See here');
});

test('whitespace-only descriptions are collected as undocumented', () => {
  const col = { info: { name: 'S', description: ' ' }, item: [{ id: 'r', name: 'r', request: { method: 'GET', description: '   ', url: 'https://x.test/a' } }] };
  const ids = collectEntries(buildDocModel(col, {})).map(e => e.id);
  assert.deepEqual(ids.sort(), ['__collection__', 'r']);
});

test('entries skipped for size or truncated by the batch cap are reported in `skipped`', async () => {
  const query = Array.from({ length: 40 }, (_, i) => ({ key: `p${i}`, value: 'x'.repeat(80) }));
  const huge = { info: { name: 'H', description: 'd' }, item: [{ id: 'big', name: 'big', request: { method: 'GET', url: { raw: 'https://x/a', query } } }] };
  const provider = fakeProvider({ items: [] });
  const tiny = await describeDocs({ provider, model: buildDocModel(huge, {}), maxContextTokens: 100 });
  assert.equal(tiny.failedBatches, 0);
  assert.ok(tiny.skipped > 0, 'oversized entries count as skipped');
  const ok = await describeDocs({ provider: fakeProvider({ items: [] }), model: buildDocModel(manyReq(3), {}) });
  assert.equal(ok.skipped, 0);
  const many = await describeDocs({ provider: fakeProvider({ items: [] }), model: buildDocModel(manyReq(2000), {}) });
  assert.match(many.warnings.join(' '), /Too many entries/);
  assert.ok(many.skipped > 0, 'entries beyond the batch cap count as skipped');
});

test('entries sharing an id count as skipped', async () => {
  const col = { info: { name: 'D', description: '' }, item: [
    { id: 'same', name: 'a', request: { method: 'GET', url: 'https://x/a' } },
    { id: 'same', name: 'b', request: { method: 'GET', url: 'https://x/b' } },
  ] };
  const r = await describeDocs({ provider: fakeProvider({ items: [] }), model: buildDocModel(col, {}) });
  assert.ok(r.skipped >= 2);
});

test('shape-only: a saved example response is sent as a shape, never its values', () => {
  const col = collection();
  col.item[0].item[0].response = [{ name: 'ok', code: 200, status: 'OK', body: '{"email":"john.doe@corp.com","n":1}' }];
  const m = buildDocModel(col, { includeExamples: true });
  const full = JSON.stringify(collectEntries(m, [], { skipped: 0 }, { shapeOnly: false }));
  assert.ok(full.includes('john.doe@corp.com'));
  const shape = JSON.stringify(collectEntries(m, [], { skipped: 0 }, { shapeOnly: true }));
  assert.ok(!shape.includes('john.doe'));
  assert.match(shape, /bodyShape/);
  assert.match(shape, /"email":"string"/);
});
