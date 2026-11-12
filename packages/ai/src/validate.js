'use strict';

const Ajv = require('ajv');
const schemas = require('./schemas');

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new Map();

function compileSchema(schema) {
  let fn = cache.get(schema);
  if (!fn) { fn = ajv.compile(schema); cache.set(schema, fn); }
  return fn;
}

function formatErrors(errors) {
  return (errors || [])
    .map(e => `${e.instancePath || '(root)'} ${e.message}`)
    .join('; ');
}

/** Validate `data` against a schema object or a registered schema name. */
function validateOutput(schemaOrName, data) {
  const schema = typeof schemaOrName === 'string' ? schemas.get(schemaOrName) : schemaOrName;
  if (!schema) return { ok: false, errors: [], formatted: `Unknown schema "${schemaOrName}"` };
  const fn = compileSchema(schema);
  const ok = fn(data) === true;
  return { ok, errors: ok ? [] : fn.errors, formatted: ok ? '' : formatErrors(fn.errors) };
}

module.exports = { compileSchema, validateOutput, formatErrors };
