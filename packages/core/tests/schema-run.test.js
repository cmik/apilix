'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { prepareCollectionRun, executePreparedCollectionRun, resolveSchemaLink, buildSchemaTest } = require('../src/collection-runner');
const { runScript } = require('../src/script-runtime');
const { summarizeRun, buildJUnitReport, buildJsonReport } = require('../src/runner-reporters');

const PET = { id: 's1', name: 'Pet', schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } };

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((res, rej) => server.listen(0, '127.0.0.1', err => err ? rej(err) : res()));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(res => server.close(res)); }
}

function payload(base, extra = {}, links = [{ schemaId: 's1', match: '2xx' }]) {
  return {
    collection: {
      info: { name: 'S' },
      item: [{ id: 'r1', name: 'Get pet', request: { method: 'GET', url: `${base}/pet`, apilix: { schemaLinks: links } } }],
      apilix: { schemas: [PET] },
    },
    environment: {}, collectionVariables: {}, globals: {}, cookies: {}, delay: 0, iterations: 1,
    ...extra,
  };
}

async function run(p) {
  const prepared = prepareCollectionRun(p);
  return executePreparedCollectionRun(prepared, {});
}

const respond = (status, body) => (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };

test('resolveSchemaLink: exact, then Nxx, then default', () => {
  const links = [{ schemaId: 'd', match: 'default' }, { schemaId: 'c', match: '2xx' }, { schemaId: 'e', match: '201' }];
  assert.equal(resolveSchemaLink(links, 201).schemaId, 'e');
  assert.equal(resolveSchemaLink(links, 200).schemaId, 'c');
  assert.equal(resolveSchemaLink(links, 500).schemaId, 'd');
  assert.equal(resolveSchemaLink([{ schemaId: 'c', match: '2xx' }], 404), null);
  assert.equal(resolveSchemaLink(undefined, 200), null);
});

test('default mode (warn): valid body gives a passing synthetic test', async () => {
  await withServer(respond(200, '{"name":"rex"}'), async base => {
    const out = await run(payload(base));
    const tr = out.iterations[0].results[0].testResults;
    assert.deepEqual(tr, [{ name: 'Schema: 200', passed: true, error: null, synthetic: true }]);
  });
});

test('warn: violation is visible, not failing, counted in schemaWarnings', async () => {
  await withServer(respond(200, '{"name":42}'), async base => {
    const out = await run(payload(base));
    const t = out.iterations[0].results[0].testResults[0];
    assert.equal(t.passed, true);
    assert.equal(t.schemaSeverity, 'warn');
    assert.match(t.error, /does not match schema "Pet"/i);
    assert.ok(!t.error.includes('42'));
    const summary = summarizeRun(out.iterations);
    assert.equal(summary.failed, 0);
    assert.equal(summary.schemaWarnings, 1);
  });
});

test('strict: violation fails the test', async () => {
  await withServer(respond(200, '{"name":42}'), async base => {
    const out = await run(payload(base, { schemaMode: 'strict' }));
    const t = out.iterations[0].results[0].testResults[0];
    assert.equal(t.passed, false);
    assert.equal(t.schemaSeverity, 'fail');
    assert.equal(summarizeRun(out.iterations).failed, 1);
  });
});

test('off: no synthetic test', async () => {
  await withServer(respond(200, '{"name":42}'), async base => {
    const out = await run(payload(base, { schemaMode: 'off' }));
    assert.deepEqual(out.iterations[0].results[0].testResults, []);
  });
});

test('no matching link or non-JSON body', async () => {
  await withServer(respond(404, '{}'), async base => {
    const out = await run(payload(base, { schemaMode: 'strict' }));
    assert.deepEqual(out.iterations[0].results[0].testResults, []);
  });
  await withServer(respond(200, 'not json'), async base => {
    const out = await run(payload(base, { schemaMode: 'strict' }));
    const t = out.iterations[0].results[0].testResults[0];
    assert.equal(t.passed, false);
    assert.match(t.error, /not valid JSON/);
  });
});

test('run mode is a ceiling: warn downgrades strict links, strict applies link modes, off disables all', async () => {
  await withServer(respond(200, '{"name":42}'), async base => {
    const link = mode => [{ schemaId: 's1', match: '200', ...(mode ? { mode } : {}) }];
    const first = async (schemaMode, mode) => (await run(payload(base, { schemaMode }, link(mode)))).iterations[0].results[0].testResults[0];
    // warn ceiling: a strict link is downgraded
    let t = await first('warn', 'strict');
    assert.equal(t.passed, true); assert.equal(t.schemaSeverity, 'warn');
    // strict ceiling: link mode applies; no link mode inherits strict
    t = await first('strict', 'warn');
    assert.equal(t.passed, true); assert.equal(t.schemaSeverity, 'warn');
    t = await first('strict', 'strict');
    assert.equal(t.passed, false);
    t = await first('strict', undefined);
    assert.equal(t.passed, false);
    // a link set to off disables that link whatever the run mode
    assert.deepEqual((await run(payload(base, { schemaMode: 'strict' }, link('off')))).iterations[0].results[0].testResults, []);
    // run off disables a strict link
    assert.deepEqual((await run(payload(base, { schemaMode: 'off' }, link('strict')))).iterations[0].results[0].testResults, []);
  });
});

test('effectiveSchemaMode truth table', () => {
  const { effectiveSchemaMode } = require('../src/collection-runner');
  const exp = { 'off/off': 'off', 'off/strict': 'off', 'warn/strict': 'warn', 'warn/warn': 'warn', 'warn/-': 'warn', 'warn/off': 'off', 'strict/strict': 'strict', 'strict/warn': 'warn', 'strict/-': 'strict', 'strict/off': 'off' };
  for (const [k, v] of Object.entries(exp)) {
    const [run, link] = k.split('/');
    assert.equal(effectiveSchemaMode(run, link === '-' ? undefined : link), v, k);
  }
});

test('empty body under a link is a skipped synthetic test, not a violation; non-JSON text stays a violation', async () => {
  await withServer((_q, res) => { res.writeHead(204); res.end(); }, async base => {
    const out = await run(payload(base, { schemaMode: 'strict' }, [{ schemaId: 's1', match: 'default' }]));
    const t = out.iterations[0].results[0].testResults[0];
    assert.equal(t.synthetic, true);
    assert.equal(t.skipped, true);
    assert.notEqual(t.passed, false);
    assert.match(t.error, /empty body, nothing to validate/);
    const summary = summarizeRun(out.iterations);
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped, 1);
  });
  assert.equal(buildSchemaTest({ status: 200, body: '   ' }, [{ schemaId: 's1', match: '200' }], [PET], 'strict').skipped, true);
  assert.equal(buildSchemaTest({ status: 200, body: 'oops' }, [{ schemaId: 's1', match: '200' }], [PET], 'strict').passed, false);
});

test('per-link mode override (strict ceiling) and missing schema', async () => {
  await withServer(respond(200, '{"name":42}'), async base => {
    const out = await run(payload(base, { schemaMode: 'strict' }, [{ schemaId: 's1', match: '200', mode: 'strict' }]));
    assert.equal(out.iterations[0].results[0].testResults[0].passed, false);
    const out2 = await run(payload(base, { schemaMode: 'strict' }, [{ schemaId: 'gone', match: 'default' }]));
    assert.match(out2.iterations[0].results[0].testResults[0].error, /not found/);
  });
});

test('payload.links keyed by request id and payload.schemas are honoured', async () => {
  await withServer(respond(200, '{"name":42}'), async base => {
    const p = payload(base, { schemaMode: 'strict', schemas: [PET], links: { r1: [{ schemaId: 's1', match: 'default' }] } }, []);
    const out = await run(p);
    assert.equal(out.iterations[0].results[0].testResults[0].passed, false);
  });
});

test('buildSchemaTest skips errored responses', () => {
  assert.equal(buildSchemaTest({ error: 'x', status: 200 }, [{ schemaId: 's1', match: '200' }], [PET], 'strict'), null);
});

test('reporters: JSON keeps synthetic flag, JUnit has testcase with failure / system-out', async () => {
  await withServer(respond(200, '{"name":42}'), async base => {
    for (const mode of ['warn', 'strict']) {
      const out = await run(payload(base, { schemaMode: mode }));
      const json = buildJsonReport({ version: 'x', runId: 'r', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: summarizeRun(out.iterations), iterations: out.iterations, errors: [] });
      const t = json.iterations[0].results[0].testResults[0];
      assert.equal(t.synthetic, true);
      const xml = buildJUnitReport({ collectionName: 'S', iterations: out.iterations, errors: [] });
      assert.match(xml, /Schema: 200/);
      if (mode === 'strict') assert.match(xml, /<failure /);
      else assert.match(xml, /<system-out>\[schema warning\]/);
    }
  });
});

test("matchSchema('name') uses the registry; unknown name has a clear error; object and not.* still work", async () => {
  const reg = [{ name: 'Pet', schema: PET.schema }];
  const resp = { code: 200, status: 'OK', responseTime: 1, headers: {}, body: '{}', jsonData: {} };
  const code = `
    apx.test('named ok', () => apx.expect({ name: 'a' }).to.matchSchema('Pet'));
    apx.test('named bad', () => apx.expect({ name: 1 }).to.matchSchema('Pet'));
    apx.test('negated', () => apx.expect({ name: 1 }).to.not.matchSchema('Pet'));
    apx.test('unknown', () => apx.expect({}).to.matchSchema('Nope'));
    apx.test('object', () => apx.expect({ name: 'a' }).to.matchSchema({ type: 'object', required: ['name'] }));
  `;
  const r = await runScript(code, resp, {}, { context: {}, schemaRegistry: reg });
  const by = Object.fromEntries(r.tests.map(t => [t.name, t]));
  assert.equal(by['named ok'].passed, true);
  assert.equal(by['named bad'].passed, false);
  assert.equal(by.negated.passed, true);
  assert.equal(by.unknown.passed, false);
  assert.match(by.unknown.error, /unknown schema "Nope".*Pet/);
  assert.equal(by.object.passed, true);
});
