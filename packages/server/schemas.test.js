'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createSchemaRouter, isSchemaPath } = require('./schema-routes');

async function withApp(fn) {
  const app = express();
  app.use('/api/schemas', createSchemaRouter());
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/schemas`;
  const post = (path, body, raw) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });
  try { await fn(post); } finally { await new Promise(r => server.close(r)); }
}

test('isSchemaPath', () => {
  assert.equal(isSchemaPath('/api/schemas/infer'), true);
  assert.equal(isSchemaPath('/api/schemasx'), false);
});

test('infer from samples and from bodies', async () => {
  await withApp(async post => {
    let r = await post('/infer', { samples: [{ a: 1 }, { a: 2, b: 'x' }], options: { requiredThreshold: 1 } });
    assert.equal(r.status, 200);
    const { schema } = await r.json();
    assert.deepEqual(schema.required, ['a']);
    r = await post('/infer', { bodies: ['{"a":"x"}'] });
    assert.equal((await r.json()).schema.properties.a.type, 'string');
  });
});

test('infer input validation', async () => {
  await withApp(async post => {
    for (const body of [{}, { samples: [] }, { samples: 'x' }, { bodies: ['{bad'] }, { bodies: [1] }, { samples: [1], options: { enums: 'yes' } }, { samples: [1], options: { requiredThreshold: 2 } }, { samples: [1], options: { maxDepth: 999 } }, { samples: Array(51).fill(1) }]) {
      const r = await post('/infer', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal((await post('/infer', null, '[1]')).status, 400);
    assert.equal((await post('/infer', null, '{bad')).status, 400);
  });
});

test('validate: valid, invalid, registry, body string', async () => {
  await withApp(async post => {
    const schema = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };
    assert.deepEqual(await (await post('/validate', { schema, data: { id: 1 } })).json(), { valid: true, errors: [] });
    const bad = await (await post('/validate', { schema, data: { id: 'SENTINEL_X' } })).json();
    assert.equal(bad.valid, false);
    assert.ok(!JSON.stringify(bad).includes('SENTINEL_X'));
    const viaBody = await (await post('/validate', { schema, body: '{"id":1}' })).json();
    assert.equal(viaBody.valid, true);
    const notJson = await (await post('/validate', { schema, body: 'nope' })).json();
    assert.equal(notJson.valid, false);
    const reg = await (await post('/validate', { schema: { $ref: 'Id' }, data: 1, schemas: [{ name: 'Id', schema: { type: 'integer' } }] })).json();
    assert.equal(reg.valid, true);
  });
});

test('validate input validation and size cap', async () => {
  await withApp(async post => {
    for (const body of [{}, { schema: 'x', data: 1 }, { schema: {} }, { schema: {}, data: 1, schemas: 'x' }, { schema: {}, data: 1, schemas: [{ name: 'a' }] }, { schema: {}, data: 1, allErrors: 'y' }]) {
      assert.equal((await post('/validate', body)).status, 400);
    }
    const big = await post('/validate', { schema: {}, data: 'x'.repeat(3 * 1024 * 1024) });
    assert.equal(big.status, 413);
  });
});

test('validate: a catastrophic pattern is cut off at the configured time limit (200 with a timeout violation)', async () => {
  const { setSchemaValidationTimeoutMs, _shutdown } = require('@apilix/core/schema-guard');
  setSchemaValidationTimeoutMs(250);
  try {
    await withApp(async post => {
      const t = Date.now();
      const r = await post('/validate', { schema: { type: 'string', pattern: '^(a+)+$' }, data: `${'a'.repeat(45)}!` });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.valid, false);
      assert.equal(j.timedOut, true);
      assert.equal(j.errors[0].keyword, 'timeout');
      assert.ok(Date.now() - t < 3000);
      assert.equal((await (await post('/validate', { schema: { type: 'string' }, data: 'x' })).json()).valid, true);
    });
  } finally { setSchemaValidationTimeoutMs(undefined); _shutdown(); }
});
