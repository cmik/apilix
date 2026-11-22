'use strict';

/**
 * Response-schema routes:
 *   POST /api/schemas/infer     { samples?: any[], bodies?: string[], options? }  -> { schema }
 *   POST /api/schemas/validate  { schema, data?|body?, schemas?, allErrors? }     -> SchemaValidationResult
 * Own 2 MB JSON parser (the app-wide one skips this prefix, see isSchemaPath).
 */

const express = require('express');
const { inferFromSamples } = require('@apilix/core/schema-inference');
const { validateWithTimeout } = require('@apilix/core/schema-guard');

const BODY_LIMIT = '2mb';
const MAX_SAMPLES = 50;
const MAX_BODY_CHARS = 1_000_000;
const MAX_REGISTRY = 200;

const BOOL_OPTIONS = ['enums', 'bounds', 'formats', 'additionalProperties'];
const INT_OPTIONS = { maxDepth: [1, 20], maxArrayItems: [1, 1000] };

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateOptions(options) {
  if (options === undefined) return { value: {} };
  if (!isPlainObject(options)) return { error: 'options must be an object' };
  const out = {};
  if (options.requiredThreshold !== undefined) {
    const t = options.requiredThreshold;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) return { error: 'options.requiredThreshold must be a number between 0 and 1' };
    out.requiredThreshold = t;
  }
  for (const k of BOOL_OPTIONS) {
    if (options[k] === undefined) continue;
    if (typeof options[k] !== 'boolean') return { error: `options.${k} must be a boolean` };
    out[k] = options[k];
  }
  for (const [k, [lo, hi]] of Object.entries(INT_OPTIONS)) {
    if (options[k] === undefined) continue;
    const n = options[k];
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: `options.${k} must be an integer between ${lo} and ${hi}` };
    out[k] = n;
  }
  return { value: out };
}

function validateRegistry(schemas) {
  if (schemas === undefined) return { value: [] };
  if (!Array.isArray(schemas) || schemas.length > MAX_REGISTRY) return { error: `schemas must be an array of at most ${MAX_REGISTRY} entries` };
  for (const s of schemas) {
    if (!isPlainObject(s) || typeof s.name !== 'string' || !s.name || s.name.length > 200 || !isPlainObject(s.schema)) {
      return { error: 'each entry of schemas must be { name: string, schema: object }' };
    }
  }
  return { value: schemas.map(s => ({ name: s.name, schema: s.schema })) };
}

function createSchemaRouter() {
  const router = express.Router();
  router.use(express.json({ limit: BODY_LIMIT }));

  router.post('/infer', (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) return res.status(400).json({ error: 'JSON object body required' });
    const opts = validateOptions(body.options);
    if (opts.error) return res.status(400).json({ error: opts.error });

    let samples;
    if (body.samples !== undefined) {
      if (!Array.isArray(body.samples) || body.samples.length === 0 || body.samples.length > MAX_SAMPLES) {
        return res.status(400).json({ error: `samples must be a non-empty array of at most ${MAX_SAMPLES} items` });
      }
      samples = body.samples;
    } else if (body.bodies !== undefined) {
      if (!Array.isArray(body.bodies) || body.bodies.length === 0 || body.bodies.length > MAX_SAMPLES) {
        return res.status(400).json({ error: `bodies must be a non-empty array of at most ${MAX_SAMPLES} strings` });
      }
      samples = [];
      for (let i = 0; i < body.bodies.length; i++) {
        const b = body.bodies[i];
        if (typeof b !== 'string' || b.length > MAX_BODY_CHARS) {
          return res.status(400).json({ error: `bodies[${i}] must be a string of at most ${MAX_BODY_CHARS} characters` });
        }
        try { samples.push(JSON.parse(b)); } catch (_) {
          return res.status(400).json({ error: `bodies[${i}] is not valid JSON` });
        }
      }
    } else {
      return res.status(400).json({ error: 'samples or bodies is required' });
    }
    try {
      return res.json({ schema: inferFromSamples(samples, opts.value) });
    } catch (_) {
      return res.status(500).json({ error: 'Schema inference failed' });
    }
  });

  router.post('/validate', (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) return res.status(400).json({ error: 'JSON object body required' });
    if (!isPlainObject(body.schema)) return res.status(400).json({ error: 'schema must be an object' });
    if (body.allErrors !== undefined && typeof body.allErrors !== 'boolean') return res.status(400).json({ error: 'allErrors must be a boolean' });
    const reg = validateRegistry(body.schemas);
    if (reg.error) return res.status(400).json({ error: reg.error });

    let data;
    if (body.body !== undefined) {
      if (typeof body.body !== 'string' || body.body.length > MAX_BODY_CHARS) {
        return res.status(400).json({ error: `body must be a string of at most ${MAX_BODY_CHARS} characters` });
      }
      try { data = JSON.parse(body.body); } catch (_) {
        return res.json({ valid: false, errors: [{ path: '', keyword: 'parse', message: 'Response body is not valid JSON' }] });
      }
    } else if ('data' in body) {
      data = body.data;
    } else {
      return res.status(400).json({ error: 'data or body is required' });
    }
    try {
      // Time-bounded (settings: schemaValidationTimeoutMs); an overrun is reported in the result, not as an HTTP error.
      return res.json(validateWithTimeout(body.schema, data, { schemas: reg.value, allErrors: body.allErrors !== false }));
    } catch (_) {
      return res.status(500).json({ error: 'Schema validation failed' });
    }
  });

  // Body parser errors (too large / malformed JSON)
  router.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: `Request body is too large (limit ${BODY_LIMIT})` });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    return res.status(500).json({ error: 'Internal error' });
  });

  return router;
}

function isSchemaPath(p) {
  return typeof p === 'string' && (p === '/api/schemas' || p.startsWith('/api/schemas/'));
}

module.exports = { createSchemaRouter, isSchemaPath, validateOptions };
