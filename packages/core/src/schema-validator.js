'use strict';

/**
 * JSON Schema validation (single Ajv 8 + ajv-formats), shared by the script sandbox
 * (`matchSchema`), the collection runner and the /api/schemas routes.
 *
 * - compiled validators are cached;
 * - a registry of named schemas lets one schema `$ref` another by name (`{ "$ref": "Pet" }`);
 * - errors are capped at MAX_ERRORS (`truncated` is set) and their messages never echo data values.
 */

const MAX_ERRORS = 50;
const MAX_CACHE = 200;
const MAX_REGISTRIES = 20;

let _classes = null;
function ajvClasses() {
  if (!_classes) {
    const AjvModule = require('ajv');
    const Ajv = AjvModule.default || AjvModule;
    const addFormatsModule = require('ajv-formats');
    const addFormats = addFormatsModule.default || addFormatsModule;
    _classes = { Ajv, addFormats };
  }
  return _classes;
}

function makeAjv(allErrors) {
  const { Ajv, addFormats } = ajvClasses();
  const ajv = new Ajv({ allErrors: !!allErrors, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  return ajv;
}

/** Drop the root `$schema` so 2019/2020 URIs do not fail to resolve against the draft-07 Ajv. */
function prepare(schema) {
  if (schema && typeof schema === 'object' && !Array.isArray(schema) && '$schema' in schema) {
    const { $schema, ...rest } = schema; // eslint-disable-line no-unused-vars
    return rest;
  }
  return schema;
}

/** Message built from the keyword and the SCHEMA parameters only: never from the validated data. */
function safeMessage(err) {
  const p = err.params || {};
  switch (err.keyword) {
    case 'type': return `must be ${Array.isArray(p.type) ? p.type.join(' or ') : p.type}`;
    case 'required': return `missing required property "${p.missingProperty}"`;
    case 'additionalProperties': return 'must not have additional properties';
    case 'enum': return 'must be one of the allowed values';
    case 'const': return 'must equal the constant value';
    case 'format': return `must match format "${p.format}"`;
    case 'pattern': return 'must match the required pattern';
    case 'minimum': case 'maximum': case 'exclusiveMinimum': case 'exclusiveMaximum':
      return `must be ${p.comparison || ''} ${p.limit}`.replace(/\s+/g, ' ').trim();
    case 'minLength': return `must have at least ${p.limit} characters`;
    case 'maxLength': return `must have at most ${p.limit} characters`;
    case 'minItems': return `must have at least ${p.limit} items`;
    case 'maxItems': return `must have at most ${p.limit} items`;
    case 'uniqueItems': return 'must not contain duplicate items';
    case 'oneOf': return 'must match exactly one of the allowed schemas';
    case 'anyOf': return 'must match at least one of the allowed schemas';
    case 'not': return 'must not match the schema';
    default: return `failed "${err.keyword}" validation`;
  }
}

function toErrors(ajvErrors) {
  const list = ajvErrors || [];
  const errors = list.slice(0, MAX_ERRORS).map(e => ({
    path: e.instancePath || '',
    keyword: e.keyword,
    message: safeMessage(e),
  }));
  return { errors, truncated: list.length > MAX_ERRORS };
}

class SchemaValidator {
  /**
   * @param {{ schemas?: Array<{name: string, schema: object}>, allErrors?: boolean }} [opts]
   */
  constructor(opts = {}) {
    this.allErrors = !!opts.allErrors;
    this.ajv = makeAjv(this.allErrors);
    this.cache = new Map(); // JSON string -> compiled fn
    this.names = new Map(); // name -> schema (raw)
    this.registryErrors = [];
    for (const s of Array.isArray(opts.schemas) ? opts.schemas : []) {
      if (!s || typeof s.name !== 'string' || !s.schema || typeof s.schema !== 'object') continue;
      this.names.set(s.name, s.schema);
      try { this.ajv.addSchema(prepare(s.schema), s.name); } catch (e) {
        this.registryErrors.push({ name: s.name, message: String(e && e.message || e).slice(0, 300) });
      }
    }
  }

  has(name) { return this.names.has(name); }

  listNames() { return [...this.names.keys()].sort(); }

  _compile(schema) {
    const key = JSON.stringify(schema);
    let fn = this.cache.get(key);
    if (fn) { this.cache.delete(key); this.cache.set(key, fn); return fn; }
    fn = this.ajv.compile(prepare(schema));
    this.cache.set(key, fn);
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
    return fn;
  }

  /**
   * @param {string|object} nameOrSchema  registry name or a schema object
   * @param {unknown} data
   * @returns {import('../types').SchemaValidationResult}
   */
  validate(nameOrSchema, data) {
    let schema = nameOrSchema;
    if (typeof nameOrSchema === 'string') {
      if (!this.names.has(nameOrSchema)) {
        throw new Error(`Unknown schema "${nameOrSchema}". Known schemas: ${this.listNames().join(', ') || '(none)'}`);
      }
      schema = this.names.get(nameOrSchema);
    }
    if (schema === null || typeof schema !== 'object') {
      return { valid: false, errors: [], schemaError: 'Schema must be an object or boolean' };
    }
    let fn;
    try { fn = this._compile(schema); } catch (e) {
      return { valid: false, errors: [], schemaError: String(e && e.message || e).slice(0, 300) };
    }
    if (typeof fn !== 'function') {
      return { valid: false, errors: [], schemaError: 'Schema could not be compiled' };
    }
    const valid = fn(data) === true;
    if (valid) return { valid: true, errors: [] };
    const { errors, truncated } = toErrors(fn.errors);
    const res = { valid: false, errors };
    if (truncated) res.truncated = true;
    return res;
  }
}

const _registries = new Map(); // fingerprint -> SchemaValidator (LRU)

function getValidator(opts = {}) {
  const schemas = Array.isArray(opts.schemas) ? opts.schemas : [];
  const fp = `${opts.allErrors ? 1 : 0}|${JSON.stringify(schemas.map(s => [s && s.name, s && s.schema]))}`;
  let v = _registries.get(fp);
  if (v) { _registries.delete(fp); _registries.set(fp, v); return v; }
  v = new SchemaValidator({ schemas, allErrors: opts.allErrors });
  _registries.set(fp, v);
  if (_registries.size > MAX_REGISTRIES) _registries.delete(_registries.keys().next().value);
  return v;
}

function createSchemaValidator(opts) { return new SchemaValidator(opts); }

/** Validate `data` against a schema object or a named registry schema. */
function validateAgainstSchema(nameOrSchema, data, opts) {
  return getValidator(opts).validate(nameOrSchema, data);
}

module.exports = { MAX_ERRORS, SchemaValidator, createSchemaValidator, validateAgainstSchema, getValidator };
