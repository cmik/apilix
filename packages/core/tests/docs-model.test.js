'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDocModel } = require('../src/docs/doc-model');
const { REDACTED } = require('../src/docs/doc-redact');
const { makeCollection, SECRETS } = require('./docs-fixtures');

test('model structure, skipping non-HTTP and disabled entries', () => {
  const m = buildDocModel(makeCollection());
  assert.equal(m.requests.length, 3);
  assert.equal(m.tree[0].type, 'folder');
  assert.equal(m.tree[0].children.length, 2);
  assert.ok(m.warnings.some(w => /Mongo thing/.test(w)));
  const get = m.requests[0];
  assert.equal(get.method, 'GET');
  assert.equal(get.baseUrl, '{{baseUrl}}');
  assert.equal(get.path, '/users/:id');
  assert.equal(get.url, '{{baseUrl}}/users/:id');
  assert.deepEqual(get.pathVariables.map(p => [p.key, p.value]), [['id', '42']]);
  assert.deepEqual(get.headers.map(h => h.key), ['Authorization', 'X-Trace']);
  assert.deepEqual(get.folderPath, ['Users']);
  assert.equal(get.examples.length, 2);
});

test('credentials are redacted by default everywhere', () => {
  const json = JSON.stringify(buildDocModel(makeCollection()));
  for (const s of SECRETS) assert.ok(!json.includes(s), `${s} leaked`);
  assert.ok(json.includes(REDACTED));
});

test('includeCredentials opt-in keeps literals', () => {
  const json = JSON.stringify(buildDocModel(makeCollection(), { includeCredentials: true }));
  assert.ok(json.includes('SECRET-COLLECTION-TOKEN'));
  assert.ok(json.includes('SECRET-HEADER'));
});

test('auth inheritance: request > folder > collection, noauth honoured', () => {
  const col = makeCollection();
  col.item[0].auth = { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] };
  const m = buildDocModel(col);
  assert.equal(m.requests[0].auth.type, 'apikey');
  assert.equal(m.requests[0].auth.source, 'request');
  assert.equal(m.requests[1].auth.type, 'basic');
  assert.equal(m.requests[1].auth.source, 'folder');
  assert.equal(m.requests[2].auth.type, 'noauth');
  assert.equal(m.auth.type, 'bearer');
});

test('variable mode keep leaves {{var}}; resolve substitutes non-secret only', () => {
  const keep = buildDocModel(makeCollection());
  assert.equal(keep.requests[1].url, '{{baseUrl}}/users');
  const res = buildDocModel(makeCollection(), {
    variableMode: 'resolve',
    variables: { baseUrl: 'https://env.example.com', apiToken: 'SECRET-ENV', other: 'zzz' },
    secretVariableKeys: ['other'],
  });
  assert.equal(res.requests[1].url, 'https://env.example.com/users');
  const json = JSON.stringify(res);
  assert.ok(!json.includes('SECRET-ENV'), 'sensitive-named variable must not be substituted');
  assert.ok(json.includes('{{apiToken}}'));
});

test('resolve mode never substitutes secretVariableKeys or dynamic variables', () => {
  const col = makeCollection();
  col.item[1].request.url = '{{host}}/x/{{$guid}}/{{plain}}';
  const m = buildDocModel(col, { variableMode: 'resolve', variables: { host: 'H', plain: 'P' }, secretVariableKeys: ['host'] });
  assert.equal(m.requests[2].url, '{{host}}/x/{{$guid}}/P');
});

test('folder scope by id, name and path', () => {
  const col = makeCollection();
  col.item[0].id = 'f1';
  col.item[0].item.push({ name: 'Inner', id: 'f2', item: [{ name: 'Deep', request: { method: 'GET', url: 'https://x.test/deep' } }] });
  assert.equal(buildDocModel(col, { folder: 'f1' }).requests.length, 3);
  assert.equal(buildDocModel(col, { folder: 'Users' }).requests.length, 3);
  const inner = buildDocModel(col, { folder: 'Users/Inner' });
  assert.deepEqual(inner.requests.map(r => r.name), ['Deep']);
  assert.deepEqual(inner.requests[0].folderPath, ['Inner']);
  assert.equal(inner.requests[0].auth.source, 'collection');
  assert.throws(() => buildDocModel(col, { folder: 'Nope' }), /Folder not found/);
});

test('includeExamples false drops examples; model is deterministic', () => {
  assert.equal(buildDocModel(makeCollection(), { includeExamples: false }).requests[0].examples.length, 0);
  assert.deepEqual(buildDocModel(makeCollection()), buildDocModel(makeCollection()));
});

test('invalid collection throws', () => {
  assert.throws(() => buildDocModel({}), /info and item/);
});
