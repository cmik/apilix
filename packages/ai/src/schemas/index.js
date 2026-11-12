'use strict';

/** Registered JSON Schemas for structured model output. Feature schemas are added with their feature. */
const SCHEMAS = {
  connectionTest: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
  docDescribe: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            params: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, description: { type: 'string' } },
                required: ['name', 'description'],
                additionalProperties: false,
              },
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

function get(name) { return SCHEMAS[name]; }
function names() { return Object.keys(SCHEMAS); }

module.exports = { SCHEMAS, get, names };
