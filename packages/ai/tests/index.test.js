'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('..');

test('barrel exports the public API', () => {
  for (const k of ['createProvider', 'AiError', 'buildPreviewContext', 'redactContext', 'estimateTokens', 'getPrompt', 'validateOutput', 'scrubSecretValues']) {
    assert.ok(k in ai, k);
  }
  const p = ai.getPrompt('connectionTest', { language: 'fr' });
  assert.match(p.system, /untrusted_data/);
  assert.match(p.system, /fr/);
});
