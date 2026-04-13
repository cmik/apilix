'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runScript } = require('./sandbox');

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