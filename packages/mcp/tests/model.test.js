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
