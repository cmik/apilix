'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('../src/script-runtime');

const RESPONSE = { code: 200, status: 'OK', responseTime: 1, headers: {}, body: '', jsonData: null };

test('deps.offline blocks apx.sendRequest (no network in dry-runs)', async () => {
  const result = await runScript(
    [
      "let failure = null;",
      "apx.sendRequest('http://127.0.0.1:9/never', (e) => { failure = e; });",
      "await new Promise(r => r());",
      "await new Promise(r => r());",
      "apx.environment.set('failure', failure ? failure.message : 'none');",
    ].join('\n'),
    RESPONSE,
    {},
    { offline: true },
  );
  assert.match(result.updatedEnvMutations.failure, /offline/);
});

test('deps.timeoutMs bounds synchronous scripts', async () => {
  const started = Date.now();
  const result = await runScript('while (true) {}', RESPONSE, {}, { timeoutMs: 100 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.tests[0].name, '__ScriptError__');
  assert.equal(result.tests[0].passed, false);
});
