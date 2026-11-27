'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAgainstSchema, createSchemaValidator, MAX_ERRORS } = require('../src/schema-validator');

const schema = { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, email: { type: 'string', format: 'email' } } };

test('valid and invalid data', () => {
  assert.deepEqual(validateAgainstSchema(schema, { id: 1 }), { valid: true, errors: [] });
  const r = validateAgainstSchema(schema, { id: 'x', email: 'nope' }, { allErrors: true });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.path === '/id' && e.keyword === 'type'));
  assert.ok(r.errors.some(e => e.path === '/email' && e.keyword === 'format'));
});

test('messages never echo data values', () => {
  const S = 'SENTINEL_DATA_77';
  const s = { type: 'object', additionalProperties: false, required: ['k'], properties: { a: { enum: ['x'] }, b: { const: 1 }, c: { type: 'string', pattern: '^z+$' }, d: { type: 'integer' }, e: { type: 'string', format: 'uuid' } } };
  const r = validateAgainstSchema(s, { a: S, b: S, c: S, d: S, e: S, [`extra_${S}`]: S }, { allErrors: true });
  assert.equal(r.valid, false);
  for (const e of r.errors) assert.ok(!e.message.includes(S));
});

test('error cap at 50 with truncated flag', () => {
  const s = { type: 'array', items: { type: 'integer' } };
  const r = validateAgainstSchema(s, Array.from({ length: 200 }, () => 'x'), { allErrors: true });
  assert.equal(r.errors.length, MAX_ERRORS);
  assert.equal(r.truncated, true);
  const first = validateAgainstSchema(s, ['x', 'y'], { allErrors: false });
  assert.equal(first.errors.length, 1);
});

test('registry: $ref by name and unknown name error', () => {
  const schemas = [
    { name: 'Pet', schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
    { name: 'Pets', schema: { type: 'array', items: { $ref: 'Pet' } } },
  ];
  const v = createSchemaValidator({ schemas });
  assert.equal(v.validate('Pets', [{ name: 'a' }]).valid, true);
  assert.equal(v.validate('Pets', [{ name: 1 }]).valid, false);
  assert.throws(() => v.validate('Nope', {}), /Unknown schema "Nope"/);
  assert.equal(validateAgainstSchema({ $ref: 'Pet' }, { name: 'x' }, { schemas }).valid, true);
});

test('broken schema reports schemaError instead of throwing; remote $ref is not fetched', () => {
  assert.ok(validateAgainstSchema({ type: 'nonsense' }, 1).schemaError);
  assert.ok(validateAgainstSchema({ $ref: 'http://127.0.0.1:1/x.json' }, 1).schemaError);
});

test('2020-12 $schema URI is tolerated', () => {
  assert.equal(validateAgainstSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' }, 'x').valid, true);
});
