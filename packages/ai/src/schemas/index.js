'use strict';

/** Registered JSON Schemas for structured model output. Feature schemas are added with their feature. */
const SCHEMAS = {
  connectionTest: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
};

function get(name) { return SCHEMAS[name]; }
function names() { return Object.keys(SCHEMAS); }

module.exports = { SCHEMAS, get, names };
