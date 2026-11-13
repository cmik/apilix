'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listNodes, findNode, countRequests, buildRunTree, describeRequest } = require('../src/model');
const { createRedactor } = require('../src/redact');
const { collectionFixture, SECRET_TOKEN, LITERAL_AUTH, PASSWORD } = require('./fixtures');

test('listNodes returns folders and requests depth-first with refs and paths', () => {
  const nodes = listNodes(collectionFixture());
  assert.deepEqual(nodes.map((n) => `${n.type}:${n.path}`), [
    'folder:Users', 'request:Users/List users', 'request:Users/Create user', 'request:Ping', 'request:Fails',
  ]);
  assert.equal(nodes[1].ref, 'req-list');
});

test('findNode resolves by id, by path, by unique name, by positional ref; errors on none/ambiguity', () => {
  const c = collectionFixture();
  assert.equal(findNode(c, 'req-ping').path, 'Ping');
  assert.equal(findNode(c, 'Users/Create user').ref, 'req-create');
  assert.equal(findNode(c, 'Ping').ref, 'req-ping');
  assert.equal(findNode(c, '@0/1').ref, 'req-create');
  assert.equal(findNode(c, 'Users', { type: 'folder' }).type, 'folder');
  assert.throws(() => findNode(c, 'nope'), /No item matches/);
  assert.throws(() => findNode(c, 'Users', { type: 'request' }), /No request matches/);
  const dup = { info: { name: 'd' }, item: [{ name: 'A', request: { method: 'GET', url: 'x' } }, { name: 'A', request: { method: 'GET', url: 'y' } }] };
  assert.throws(() => findNode(dup, 'A'), /ambiguous/);
  assert.equal(findNode(dup, '@1').node.request.url, 'y');
});

test('buildRunTree keeps ancestor folders for one request, full subtree for a folder, and does not mutate the source', () => {
  const c = collectionFixture();
  c.item[0].event = [{ listen: 'prerequest', script: { exec: ['// folder script'] } }];
  const before = JSON.stringify(c);
  const one = buildRunTree(c, [0, 1]);
  assert.equal(countRequests(one.collection.item), 1);
  assert.equal(one.collection.item[0].name, 'Users');
  assert.ok(one.collection.item[0].event, 'folder scripts preserved');
  assert.equal(one.collection.item[0].item[0].name, 'Create user');
  const folder = buildRunTree(c, [0]);
  assert.equal(countRequests(folder.collection.item), 2);
  assert.equal(countRequests(buildRunTree(c, null).collection.item), 4);
  assert.equal(JSON.stringify(c), before);
});

test('buildRunTree drops non-HTTP requests and strips per-request proxy settings', () => {
  const c = { info: { name: 'x' }, item: [
    { name: 'm', request: { method: 'GET', url: 'x', requestType: 'mongodb', mongodb: {} } },
    { name: 'q', request: { method: 'MYSQL', url: 'x' } },
    { name: 'ok', request: { method: 'GET', url: 'http://a', requestSettings: { proxyEnabled: true, httpProxy: 'http://evil', timeout: 5 } } },
  ] };
  const t = buildRunTree(c, null);
  assert.deepEqual(t.skippedNonHttp, ['m', 'q']);
  assert.equal(t.collection.item.length, 1);
  assert.deepEqual(t.collection.item[0].request.requestSettings, { timeout: 5 });
});

test('describeRequest is redacted: URL query, headers, raw body, auth; no secret survives', () => {
  const c = collectionFixture();
  const red = createRedactor();
  red.addCollection(c);
  const d = describeRequest(findNode(c, 'req-list'), red);
  const text = JSON.stringify(d);
  for (const s of [SECRET_TOKEN, PASSWORD, LITERAL_AUTH]) assert.ok(!text.includes(s), s);
  assert.equal(d.method, 'GET');
  assert.ok(d.url.startsWith('{{base}}/users?page=1'));
  assert.equal(d.headers.find((h) => h.key === 'Authorization').value, '<redacted>');
  assert.equal(d.headers.find((h) => h.key === 'X-Trace').value, 'abc');
  assert.ok(d.scripts.tests.includes('status is 200'));
  const create = describeRequest(findNode(c, 'req-create'), red);
  assert.ok(!JSON.stringify(create).includes(PASSWORD));
  assert.ok(create.body.raw.includes('"name"'));
});

test('describeRequest redacts auth blocks on the request itself', () => {
  const red = createRedactor();
  const item = { name: 'a', request: { method: 'GET', url: 'x', auth: { type: 'basic', basic: [{ key: 'username', value: 'bob' }, { key: 'password', value: 'hunter2pw' }] } } };
  const d = describeRequest({ node: item, ref: '@0', path: 'a' }, red);
  assert.deepEqual(d.auth, { type: 'basic', fields: { username: '<redacted>', password: '<redacted>' } });
});

const { findHostOverride, classifyUrl } = require('../src/model');

const col = (item, extra = {}) => ({ info: { name: 'G' }, item: [{ name: 'R', request: { method: 'GET', url: item.url, auth: item.auth, header: [] } }], ...extra });

test('classifyUrl reads the authority like the WHATWG parser and flags ambiguous ones', () => {
  assert.deepEqual(classifyUrl('http://127.0.0.1:81/x/{{id}}?k={{k}}'), { kind: 'host', host: '127.0.0.1:81' });
  assert.deepEqual(classifyUrl('HTTP://User@Example.COM:80/x'), { kind: 'host', host: 'example.com' });
  assert.equal(classifyUrl('http://{{host}}/x').kind, 'unresolved');
  assert.equal(classifyUrl('{{base}}/x').kind, 'unresolved');
  assert.deepEqual(classifyUrl('http://127.0.0.1:81\\@127.0.0.1:82/x'), { kind: 'host', host: '127.0.0.1:81' }, 'a backslash ends the authority, as the client reads it');
  assert.deepEqual(classifyUrl('http://127.0.0.1:81#@127.0.0.1:82/x'), { kind: 'host', host: '127.0.0.1:81' });
  assert.equal(classifyUrl('http://127.0.0.1:81\t.x/').kind, 'refuse', 'tab in the authority');
  assert.equal(classifyUrl('http://127.0.0.1:81\n@127.0.0.1:82/').kind, 'refuse', 'newline in the authority');
  assert.equal(classifyUrl('ht\ttp://a.com/').kind, 'refuse', 'tab in the scheme');
  assert.equal(classifyUrl('http://a b.com/').kind, 'refuse', 'space in the authority');
  assert.equal(classifyUrl('http://{{y}}@evil.test/').kind, 'host', 'a placeholder in the userinfo does not hide the host');
  assert.equal(classifyUrl('http://evil.test/{{x}}').kind, 'host');
  assert.equal(classifyUrl('/relative').kind, 'invalid');
});

test('findHostOverride: a placeholder elsewhere in the URL no longer disables the check', () => {
  const c = col({ url: 'http://{{host}}/x/{{id}}?k={{k}}' }, { variable: [{ key: 'host', value: '127.0.0.1:81' }] });
  assert.equal(findHostOverride(c, { dataRows: [{ id: '7', k: '1' }] }), null, 'changing a path/query placeholder is fine');
  const hit = findHostOverride(c, { dataRows: [{ host: '127.0.0.1:82', id: '1' }] });
  assert.ok(hit);
  assert.equal(hit.from, '127.0.0.1:81');
  assert.equal(hit.to, '127.0.0.1:82');
});

test('findHostOverride: differential authority tricks are refused, a defined host cannot be moved', () => {
  const c = col({ url: 'http://{{host}}/x' }, { variable: [{ key: 'host', value: '127.0.0.1:81' }] });
  for (const evil of ['127.0.0.1:82\\@127.0.0.1:81', '127.0.0.1:82#@127.0.0.1:81', '127.0.0.1:81\t@x', '127.0.0.1:81\n.evil', '127.0.0.1:82/x@127.0.0.1:81', '127.0.0.1:81 .evil']) {
    assert.ok(findHostOverride(c, { dataRows: [{ host: evil }] }), JSON.stringify(evil));
  }
});

test('findHostOverride: no baseline is refused with anyHost, left to the --allow-host list otherwise', () => {
  const c = col({ url: 'http://{{nb}}/x/{{id}}' });
  const rows = [{ nb: '127.0.0.1:82', id: '1' }];
  const hit = findHostOverride(c, { dataRows: rows, anyHost: true });
  assert.ok(hit && hit.noBaseline);
  assert.equal(findHostOverride(c, { dataRows: rows, anyHost: false }), null);
  assert.equal(findHostOverride(c, { dataRows: [{ id: '1' }], anyHost: true }), null, 'nothing defines the host: nothing is sent anywhere');
  // an agent value that is itself a placeholder or smuggles one is not a way around it
  assert.ok(findHostOverride(c, { dataRows: [{ nb: '{{z}}.evil.test' }], anyHost: true }));
  assert.ok(findHostOverride(c, { dataRows: [{ nb: '{{z}}@127.0.0.1:82' }], anyHost: true }));
});

test('findHostOverride covers OAuth endpoints (request, folder, collection) and the url parts form', () => {
  const oauth = (tokenUrl) => ({ type: 'oauth2', oauth2: { grantType: 'client_credentials', clientId: 'id', clientSecret: 'literalSecretValue', tokenUrl } });
  const attack = { tok: 'http://127.0.0.1:82/token' };
  const reqLevel = col({ url: 'http://127.0.0.1:81/x', auth: oauth('{{tok}}') });
  assert.ok(findHostOverride(reqLevel, { variables: attack, anyHost: true }), 'undefined tokenUrl host');
  assert.equal(findHostOverride(reqLevel, { variables: attack, anyHost: false }), null, '--allow-host: the list decides');
  const withBase = col({ url: 'http://127.0.0.1:81/x', auth: oauth('{{tok}}') }, { variable: [{ key: 'tok', value: 'http://127.0.0.1:81/token' }] });
  const moved = findHostOverride(withBase, { variables: attack });
  assert.ok(moved && /oauth2\.tokenUrl/.test(moved.field));
  const inFolder = { info: { name: 'G' }, item: [{ name: 'F', auth: oauth('{{tok}}'), item: [{ name: 'R', request: { method: 'GET', url: 'http://127.0.0.1:81/x' } }] }] };
  assert.ok(findHostOverride(inFolder, { variables: attack, anyHost: true }));
  const inCollection = { info: { name: 'G' }, auth: { type: 'oauth2', oauth2: [{ key: 'tokenUrl', value: '{{tok}}' }] }, item: [{ name: 'R', request: { method: 'GET', url: 'http://127.0.0.1:81/x' } }] };
  assert.ok(findHostOverride(inCollection, { variables: attack, anyHost: true }));
  const parts = { info: { name: 'G' }, variable: [{ key: 'h', value: 'a.test' }], item: [{ name: 'R', request: { method: 'GET', url: { protocol: 'http', host: ['{{h}}'], path: ['x'] } } }] };
  assert.ok(findHostOverride(parts, { dataRows: [{ h: 'b.test' }] }));
});
