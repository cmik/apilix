'use strict';

/** Registered JSON Schemas for structured model output. Feature schemas are added with their feature. */
const PAIR = {
  type: 'object',
  properties: { key: { type: 'string', maxLength: 200 }, value: { type: 'string', maxLength: 2000 } },
  required: ['key'],
  additionalProperties: false,
};

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
                properties: { in: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
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
  assertSuggest: {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', maxLength: 80 },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            kind: { type: 'string', enum: ['status', 'header', 'body', 'schema', 'timing', 'capture'] },
            script: { type: 'string', minLength: 1, maxLength: 4000 },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            volatile: { type: 'boolean' },
          },
          required: ['title', 'kind', 'script', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  },
  explainFailure: {
    type: 'object',
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 600 },
      likelyCauses: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            cause: { type: 'string', minLength: 1, maxLength: 400 },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          required: ['cause', 'confidence'],
          additionalProperties: false,
        },
      },
      suggestedFixes: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', minLength: 1, maxLength: 400 },
            kind: { type: 'string', enum: ['assertion', 'request', 'environment', 'other'] },
            snippet: { type: 'string', maxLength: 1500 },
          },
          required: ['description', 'kind'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'likelyCauses', 'suggestedFixes'],
    additionalProperties: false,
  },
  requestDraft: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
      url: { type: 'string', maxLength: 2000 },
      headers: { type: 'array', maxItems: 30, items: PAIR },
      query: { type: 'array', maxItems: 30, items: PAIR },
      body: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['none', 'raw', 'formdata', 'urlencoded'] },
          raw: { type: 'string', maxLength: 20000 },
          language: { type: 'string', enum: ['json', 'text', 'xml', 'html', 'javascript'] },
          formdata: { type: 'array', maxItems: 40, items: PAIR },
          urlencoded: { type: 'array', maxItems: 40, items: PAIR },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      auth: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['noauth', 'inherit', 'bearer', 'basic', 'apikey'] },
          token: { type: 'string', maxLength: 500 },
          username: { type: 'string', maxLength: 500 },
          password: { type: 'string', maxLength: 500 },
          key: { type: 'string', maxLength: 200 },
          value: { type: 'string', maxLength: 500 },
          in: { type: 'string', enum: ['header', 'query'] },
        },
        required: ['type'],
        additionalProperties: false,
      },
      tests: { type: 'string', maxLength: 6000 },
      preRequest: { type: 'string', maxLength: 4000 },
      variablesToCapture: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: { name: { type: 'string', maxLength: 60 }, path: { type: 'string', maxLength: 120 } },
          required: ['name', 'path'],
          additionalProperties: false,
        },
      },
    },
    required: ['name', 'method', 'url'],
    additionalProperties: false,
  },
};

function get(name) { return SCHEMAS[name]; }
function names() { return Object.keys(SCHEMAS); }

module.exports = { SCHEMAS, get, names };
