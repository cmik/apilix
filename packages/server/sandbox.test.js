'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runScript, createScriptContext } = require('@apilix/core');

const baseResponse = {
  code: 200,
  status: 'OK',
  responseTime: 12,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 123, email: 'user@example.com' }),
  jsonData: { id: 123, email: 'user@example.com' },
};

async function run(code) {
  return runScript(code, baseResponse, {}, { context: {} });
}

test('not.matchSchema inverts schema validation results', async () => {
  const result = await run(`
    const schema = {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer' } },
      additionalProperties: false,
    };

    pm.test('invalid payload passes negated schema', () => {
      pm.expect({ id: 'wrong' }).to.not.matchSchema(schema);
    });

    pm.test('valid payload fails negated schema', () => {
      pm.expect({ id: 123 }).to.not.matchSchema(schema);
    });
  `);

  assert.equal(result.tests.length, 2);
  assert.deepEqual(result.tests[0], {
    name: 'invalid payload passes negated schema',
    passed: true,
    error: null,
    skipped: false,
  });
  assert.equal(result.tests[1].name, 'valid payload fails negated schema');
  assert.equal(result.tests[1].passed, false);
  assert.match(result.tests[1].error, /Expected value to not match schema/);
});

test('matchSchema validates formats via ajv-formats', async () => {
  const result = await run(`
    const schema = {
      type: 'object',
      required: ['email'],
      properties: { email: { type: 'string', format: 'email' } },
      additionalProperties: false,
    };

    pm.test('valid email matches schema', () => {
      pm.expect({ email: 'person@example.com' }).to.matchSchema(schema);
    });

    pm.test('invalid email fails schema', () => {
      pm.expect({ email: 'not-an-email' }).to.matchSchema(schema);
    });
  `);

  assert.equal(result.tests[0].passed, true);
  assert.equal(result.tests[1].passed, false);
  assert.match(result.tests[1].error, /must match format/);
});

test('softExpect failures stay scoped to the current test', async () => {
  const result = await run(`
    pm.test('soft assertion without assertAll does not fail the test', () => {
      pm.softExpect(1).to.equal(2);
    });

    pm.test('assertAll only reports current test failures', () => {
      pm.softExpect('alpha').to.equal('beta');
      pm.assertAll('scoped failures');
    });

    pm.test('later test still passes', () => {
      pm.expect(true).to.be.true;
    });
  `);

  assert.deepEqual(result.tests[0], {
    name: 'soft assertion without assertAll does not fail the test',
    passed: true,
    error: null,
    skipped: false,
  });
  assert.equal(result.tests[1].passed, false);
  assert.match(result.tests[1].error, /scoped failures: 1 soft assertion\(s\) failed/);
  assert.equal(result.tests[2].passed, true);
});

test('test.skip records skipped tests without executing the callback', async () => {
  const result = await run(`
    pm.test.skip('coming soon', () => {
      throw new Error('skip callback should not run');
    });
  `);

  assert.deepEqual(result.tests, [
    {
      name: 'coming soon',
      passed: null,
      error: null,
      skipped: true,
    },
  ]);
});

test('setNextRequestById sets nextRequestById signal', async () => {
  const result = await run(`
    apx.execution.setNextRequestById('abc-123');
  `);

  assert.equal(result.nextRequestById, 'abc-123');
  assert.equal(result.nextRequest, undefined);
});

test('setNextRequestById(null) sets nextRequestById to null', async () => {
  const result = await run(`
    apx.execution.setNextRequestById(null);
  `);

  assert.equal(result.nextRequestById, null);
});

test('setNextRequest and setNextRequestById can both be set independently', async () => {
  const result = await run(`
    apx.execution.setNextRequest('by-name');
    apx.execution.setNextRequestById('abc-456');
  `);

  assert.equal(result.nextRequest, 'by-name');
  assert.equal(result.nextRequestById, 'abc-456');
});

test('apx.environment.set() on a new key is tracked in updatedEnvMutations', async () => {
  const result = await runScript(
    `apx.environment.set('brandNewVar', 'hello');`,
    baseResponse,
    {},
    { context: { environment: {} } },
  );

  assert.equal(result.updatedEnvMutations['brandNewVar'], 'hello');
  assert.equal(result.updatedVariables['brandNewVar'], 'hello');
});

test('apx.environment.set() on a new key does not bleed into updatedCollVarMutations', async () => {
  const result = await runScript(
    `apx.environment.set('envOnly', '1');`,
    baseResponse,
    {},
    { context: { environment: {}, collectionVariables: {} } },
  );

  assert.equal(result.updatedEnvMutations['envOnly'], '1');
  assert.equal(result.updatedCollVarMutations['envOnly'], undefined);
});

test('apx.environment.set() on a pre-existing key is still tracked in updatedEnvMutations', async () => {
  const result = await runScript(
    `apx.environment.set('existingVar', 'updated');`,
    baseResponse,
    {},
    { context: { environment: { existingVar: 'original' } } },
  );

  assert.equal(result.updatedEnvMutations['existingVar'], 'updated');
});

test('apx.variables.set() on a new key does NOT appear in updatedEnvMutations', async () => {
  const result = await runScript(
    `apx.variables.set('genericVar', '42');`,
    baseResponse,
    {},
    { context: { environment: {} } },
  );

  assert.equal(result.updatedVariables['genericVar'], '42');
  assert.equal(result.updatedEnvMutations['genericVar'], undefined);
});

// ─── XML response parsing ─────────────────────────────────────────────────────

const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <tokenResponse>
      <token>abc123</token>
      <expiry>3600</expiry>
    </tokenResponse>
  </soap:Body>
</soap:Envelope>`;

const xmlResponse = {
  code: 200,
  status: 'OK',
  responseTime: 30,
  headers: { 'content-type': 'text/xml' },
  body: xmlBody,
  jsonData: null,
};

async function runXml(code) {
  return runScript(code, xmlResponse, {}, { context: {} });
}

test('apx.response.xml() returns a DOM document (not null)', async () => {
  const result = await runXml(`
    const doc = apx.response.xml();
    apx.test('xml() returns a document', () => {
      apx.expect(doc != null).to.be.true;
    });
    apx.test('document has nodeType 9', () => {
      apx.expect(doc.nodeType).to.equal(9);
    });
  `);

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
  assert.equal(result.tests[1].passed, true, result.tests[1].error);
});

test('apx.response.xml() + xpath.value() extracts text from XML body', async () => {
  const result = await runXml(`
    const doc = apx.response.xml();
    const token = xpath.value('//token', doc);
    apx.test('token extracted', () => {
      apx.expect(token).to.equal('abc123');
    });
  `);

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
});

test('apx.response.xmlPath() extracts text with one-liner', async () => {
  const result = await runXml(`
    const token = apx.response.xmlPath('//token');
    apx.test('xmlPath returns token', () => {
      apx.expect(token).to.equal('abc123');
    });
  `);

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
});

test('apx.response.xmlPath() returns null when expression matches nothing', async () => {
  const result = await runXml(`
    const missing = apx.response.xmlPath('//doesNotExist');
    apx.test('xmlPath returns null for no match', () => {
      apx.expect(missing).to.be.null;
    });
  `);

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
});

test('apx.response.xmlPathAll() returns array of all matching texts', async () => {
  const result = await runXml(`
    const vals = apx.response.xmlPathAll('//*[local-name()="token" or local-name()="expiry"]');
    apx.test('xmlPathAll finds 2 nodes', () => {
      apx.expect(vals.length).to.equal(2);
    });
    apx.test('first value is token text', () => {
      apx.expect(vals[0]).to.equal('abc123');
    });
  `);

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
  assert.equal(result.tests[1].passed, true, result.tests[1].error);
});

test('apx.response.xml() + xpath.value() can store to environment', async () => {
  const result = await runXml(`
    const token = apx.response.xmlPath('//token');
    apx.environment.set('token', token);
    apx.test('token set in environment', () => {
      apx.expect(apx.environment.get('token')).to.equal('abc123');
    });
  `);

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
  assert.equal(result.updatedEnvMutations['token'], 'abc123');
});

// ─── createScriptContext / vmContext reuse ─────────────────────────────────────────

const vm = require('node:vm');

test('createScriptContext() returns a contextified VM object', () => {
  const ctx = createScriptContext();
  assert.ok(vm.isContext(ctx), 'expected vm.isContext to be true');
});

test('reused context: apx env mutations do not leak to next runScript call', async () => {
  const ctx = createScriptContext();

  // First run sets an environment variable
  await runScript(
    `apx.environment.set('leakVar', 'leaked');`,
    baseResponse,
    {},
    { context: { environment: {} } },
    ctx,
  );

  // Second run should not see the mutation in its own result
  const result = await runScript(
    `apx.test('no leak', () => {
      apx.expect(apx.environment.get('leakVar')).to.equal(undefined);
    });`,
    baseResponse,
    {},
    { context: { environment: {} } },
    ctx,
  );

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
});

test('reused context: var declaration inside IIFE does not leak to next call', async () => {
  const ctx = createScriptContext();

  await runScript(
    `var myLeakedVar = 'leaked';`,
    baseResponse,
    {},
    { context: {} },
    ctx,
  );

  const result = await runScript(
    `apx.test('no var leak', () => {
      apx.expect(typeof myLeakedVar).to.equal('undefined');
    });`,
    baseResponse,
    {},
    { context: {} },
    ctx,
  );

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
});

test('reused context: bare global assignment is cleaned up between calls', async () => {
  const ctx = createScriptContext();

  await runScript(
    `userGlobal = 'polluted';`,
    baseResponse,
    {},
    { context: {} },
    ctx,
  );

  const result = await runScript(
    `apx.test('no global leak', () => {
      apx.expect(typeof userGlobal).to.equal('undefined');
    });`,
    baseResponse,
    {},
    { context: {} },
    ctx,
  );

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
});

test('reused context: compiled script is cached (same results on second call)', async () => {
  const ctx = createScriptContext();
  const code = `apx.environment.set('hit', '1');`;

  const r1 = await runScript(code, baseResponse, {}, { context: { environment: {} } }, ctx);
  const r2 = await runScript(code, baseResponse, {}, { context: { environment: {} } }, ctx);

  // Both calls must produce the same mutation, proving the cached script runs correctly
  assert.equal(r1.updatedEnvMutations['hit'], '1');
  assert.equal(r2.updatedEnvMutations['hit'], '1');
});

test('runScript without vmContext (fresh-context path) still works correctly', async () => {
  const result = await runScript(
    `apx.test('fresh ctx', () => { apx.expect(apx.response.code).to.equal(200); });`,
    baseResponse,
    {},
    { context: {} },
  );

  assert.equal(result.tests[0].passed, true, result.tests[0].error);
});