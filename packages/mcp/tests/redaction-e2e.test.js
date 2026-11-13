'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./client');
const { makeTmp, writeJson } = require('./fixtures');

test('a 4-char secret equal to a JSON key/value of the protocol is masked and the output stays valid JSON', async (t) => {
  const dir = makeTmp();
  writeJson(dir, 'c.postman_collection.json', {
    info: { name: 'name', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'pin', value: 'name', type: 'secret' }],
    item: [{ name: 'name', id: 'r1', request: { method: 'GET', url: 'http://127.0.0.1:1/name' } }],
  });
  const s = startServer(['--workspace', dir]);
  t.after(() => s.close());
  await s.initialize();
  for (const [tool, args] of [['list_collections', {}], ['list_requests', { collection: 'c.postman_collection.json' }], ['get_request', { collection: 'c.postman_collection.json', request: 'r1' }]]) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, false, `${tool}: ${r.text}`);
    assert.ok(r.data !== undefined, `${tool}: output is valid JSON: ${r.text.slice(0, 200)}`);
    const leaves = [];
    (function walk(v) { if (typeof v === 'string') leaves.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }(r.data));
    assert.ok(!leaves.includes('name'), `${tool}: the secret value leaked as a leaf`);
    assert.ok(/"untrustedContent":true/.test(r.text) && /"collection":|"collections":/.test(r.text), `${tool}: protocol keys intact`);
    if (tool !== 'list_requests') assert.ok(r.text.includes('"name":"<redacted>"'), `${tool}: key "name" kept, value masked`);
  }
  assert.equal(s.badStdout.length, 0);
});
