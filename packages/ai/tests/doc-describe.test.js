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
