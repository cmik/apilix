'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./client');
const { startFakeApi, BODY_TOKEN } = require('./fake-server');
const { makeTmp, writeJson, SECRET_TOKEN, ENV_SECRET, PASSWORD } = require('./fixtures');

const expectStatus = (code) => ({ listen: 'test', script: { exec: [`apx.test("status is ${code}", function () { apx.expect(apx.response.code).to.equal(${code}); });`] } });
const get = (name, path, extra = {}) => ({ name, id: `id-${name}`, request: { method: 'GET', url: `{{base}}${path}`, ...(extra.request || {}) }, ...(extra.item || {}) });

function runFixture(api, { withHostile = true } = {}) {
  return {
    info: { name: 'Run API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Basic', id: 'folder-basic', item: [
        { ...get('Ping', '/ping'), event: [expectStatus(200)] },
        { ...get('Wrong', '/ping'), event: [expectStatus(201)] },
        { ...get('After', '/other'), event: [expectStatus(200)] },
      ] },
      { ...get('Echo', '/echo?token={{apiToken}}', { request: { header: [{ key: 'Authorization', value: 'Bearer {{apiToken}}' }, { key: 'X-Env-Secret', value: '{{hidden}}' }], url: '{{base}}/echo?token={{apiToken}}&pw=' + PASSWORD } }) },
      { ...get('Redirect', '/redirect') },
      { ...get('Slow', '/slow') },
      { ...get('Big', '/big') },
      { ...get('HangNoTimeout', '/hang', { request: { requestSettings: { timeout: 0 } } }) },
      { ...get('HangLongTimeout', '/hang', { request: { requestSettings: { timeout: 600000 } } }) },
      { ...get('HangScript', '/ping'), event: [{ listen: 'test', script: { exec: [`apx.sendRequest("${api.base}/hang", function () {});`] } }] },
      { name: 'Mongo', request: { method: 'GET', url: 'x', requestType: 'mongodb', mongodb: {} } },
      { name: 'Many', id: 'folder-many', item: Array.from({ length: 11 }, (_, i) => get(`M${i}`, '/m')) },
      ...(withHostile ? [
        { ...get('Hostile', '/ping'), request: { method: 'GET', url: '{{evilBase}}/hostile' } },
        { ...get('ScriptCall', '/ping'), event: [{ listen: 'test', script: { exec: ['apx.sendRequest("{{evilBase}}/from-script", function () {});'.replace('{{evilBase}}', `http://localhost:${new URL(api.base).port}`)] } }] },
      ] : []),
    ],
  };
}

const RUN_FLAGS = ['--allow-host', '--allow-any-host', '--no-run'];

/** The run tools are opt-in: unless a test chooses its own run flag, allow the local fake API host only. */
async function setup(extraArgs = [], { hostile = true, runFlags = true } = {}) {
  const api = await startFakeApi();
  const dir = makeTmp();
  writeJson(dir, 'run.postman_collection.json', runFixture(api, { withHostile: hostile }));
  writeJson(dir, 'small.postman_collection.json', { info: { name: 'Small' }, item: [get('Ping', '/ping'), { name: 'Mongo', request: { method: 'GET', url: 'x', requestType: 'mongodb', mongodb: {} } }] });
  writeJson(dir, 'env.json', {
    name: 'Env',
    values: [
      { key: 'base', value: api.base, enabled: true },
      { key: 'evilBase', value: `http://localhost:${new URL(api.base).port}`, enabled: true },
      { key: 'apiToken', value: SECRET_TOKEN, enabled: true },
      { key: 'hidden', value: ENV_SECRET, enabled: true, secret: true },
    ],
  });
  const defaults = runFlags && !extraArgs.some((a) => RUN_FLAGS.includes(a)) ? ['--allow-host', '127.0.0.1'] : [];
  const s = startServer(['--workspace', dir, ...defaults, ...extraArgs]);
  await s.initialize();
  const done = async () => { await s.close(); await api.close(); assert.equal(s.badStdout.length, 0); };
  return { api, dir, s, done, colId: 'run.postman_collection.json', envId: 'env.json' };
}

const ALL_SECRETS = [SECRET_TOKEN, ENV_SECRET, PASSWORD, BODY_TOKEN, 'cookieSecretValue123'];
function assertNoSecrets(text, label) {
  for (const sec of ALL_SECRETS) assert.ok(!text.includes(sec), `${label}: leaked ${sec}`);
}

test('run_request: happy path returns status, tests, redacted headers/body, and counts one hit', async () => {
  const { api, s, done, colId, envId } = await setup();
  try {
    const r = await s.call('run_request', { collection: colId, request: 'Basic/Ping', environment: envId });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.result.status, 200);
    assert.equal(r.data.result.tests[0].passed, true);
    assert.equal(r.data.summary.testsFailed, 0);
    assert.equal(api.hits['/ping'], 1);
    assert.ok(r.data.result.body.includes('"ok"'));
    assert.ok(r.data.result.body.includes('hello'));
    assert.equal(r.data.result.headers['set-cookie'], '<redacted>');
    assertNoSecrets(r.text, 'run_request Ping');
    assert.equal(r.data.untrustedContent, true);
  } finally { await done(); }
});

test('run_request: a secret is absent from every part of the output even when the server reflects it', async () => {
  const { s, done, colId, envId } = await setup();
  try {
    const r = await s.call('run_request', { collection: colId, request: 'Echo', environment: envId, maxBodyBytes: 65536 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.result.status, 200);
    assertNoSecrets(r.text, 'run_request Echo');
    // request side
    assert.equal(r.data.result.requestHeaders.Authorization, '<redacted>');
    assert.equal(r.data.result.requestHeaders['X-Env-Secret'], '<redacted>');
    assert.ok(!r.data.result.resolvedUrl.includes(SECRET_TOKEN));
    // reflected response side
    assert.ok(r.data.result.body.includes('plain text with'));
    assert.equal(r.data.result.headers['x-reflected'], '<redacted>');
    // the get_last_results history is clean too
    const last = await s.call('get_last_results', {});
    assertNoSecrets(last.text, 'get_last_results');
    assert.equal(last.data.runs[0].tool, 'run_request');
  } finally { await done(); }
});

test('run_request: overrides (variables/data) and environment resolution', async () => {
  const { api, s, done, colId } = await setup();
  try {
    const r = await s.call('run_request', { collection: colId, request: 'Basic/Ping', variables: { base: api.base } });
    assert.equal(r.data.result.status, 200);
    const unresolved = await s.call('run_request', { collection: colId, request: 'Basic/Ping' });
    assert.ok(unresolved.data.result.error || unresolved.data.result.status !== 200, 'without base the request cannot succeed');
    const viaData = await s.call('run_request', { collection: colId, request: 'Basic/Ping', data: { base: api.base } });
    assert.equal(viaData.data.result.status, 200);
  } finally { await done(); }
});

test('run_request refuses non-HTTP requests and unknown refs', async () => {
  const { s, done, colId } = await setup();
  try {
    const m = await s.call('run_request', { collection: colId, request: 'Mongo' });
    assert.equal(m.isError, true);
    assert.match(m.text, /Only HTTP/);
    const n = await s.call('run_request', { collection: colId, request: 'Nope' });
    assert.equal(n.isError, true);
  } finally { await done(); }
});

test('run_collection: summary, failures, folder, iterations, data, bail, junit', async () => {
  const { api, s, done, colId, envId } = await setup([], { hostile: false });
  try {
    const f = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId });
    assert.equal(f.isError, false, f.text);
    assert.equal(f.data.summary.requests, 3);
    assert.equal(f.data.summary.testsFailed, 1);
    assert.equal(f.data.ok, false);
    assert.equal(f.data.failures.length, 1);
    assert.equal(f.data.failures[0].name, 'Wrong');
    assert.equal(f.data.failures[0].failedTests[0].name, 'status is 201');
    assert.equal(f.data.results.length, 3);
    assert.ok(!('body' in f.data.results[0]), 'bodies are omitted by default');
    assertNoSecrets(f.text, 'run_collection');

    const it = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId, iterations: 2, bail: false });
    assert.equal(it.data.summary.requests, 6);

    const before = api.hits['/other'] || 0;
    const bail = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId, bail: true });
    assert.equal(bail.data.summary.requests, 2, 'stopped after the failing request');
    assert.equal(bail.data.stopped, true);
    assert.equal(api.hits['/other'] || 0, before, 'the request after the failure never ran');

    const data = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId, data: [{ a: '1' }, { a: '2' }, { a: '3' }] });
    assert.equal(data.data.summary.requests, 9);
    const both = await s.call('run_collection', { collection: colId, data: [{ a: '1' }], iterations: 2 });
    assert.equal(both.isError, true);

    const junit = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId, reporter: 'junit' });
    assert.ok(junit.data.report.startsWith('<?xml'));
    assert.ok(junit.data.report.includes('status is 201'));
    assert.ok(!('results' in junit.data));
    assertNoSecrets(junit.text, 'junit');
  } finally { await done(); }
});

test('run_collection: non-HTTP requests are skipped and reported; folder must be a folder', async () => {
  const { s, done, colId, envId } = await setup([], { hostile: false });
  try {
    const r = await s.call('run_collection', { collection: 'small.postman_collection.json', environment: envId });
    assert.deepEqual(r.data.skippedNonHttpRequests, ['Mongo']);
    assert.equal(r.data.summary.requests, 1);
    const bad = await s.call('run_collection', { collection: colId, folder: 'Ping' });
    assert.equal(bad.isError, true);
  } finally { await done(); }
});

test('run_collection output is bounded: maxResults, body limits, --max-output', async () => {
  const { s, done, colId, envId } = await setup(['--max-output', '3000'], { hostile: false });
  try {
    const r = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId, maxResults: 1 });
    assert.equal(r.data.results.length, 1);
    assert.equal(r.data.omittedResults, 2);
    const big = await s.call('run_request', { collection: colId, request: 'Big', environment: envId, maxBodyBytes: 100 });
    assert.equal(big.data.result.body.length, 100);
    assert.equal(big.data.result.bodyTruncated, true);
    assert.equal(big.data.result.bodyChars, 200000);
    const many = await s.call('run_collection', { collection: colId, environment: envId, folder: 'Basic', iterations: 20, includeResponseBody: true, maxBodyBytes: 1000 });
    assert.ok(many.text.length <= 3000 + 200, `bounded (${many.text.length})`);
    assert.ok(many.data.truncated === true || many.data.resultsTruncated === true || many.data.omittedResults > 0);
  } finally { await done(); }
});

test('--no-run: run tools are not listed, calls are refused, nothing is sent', async () => {
  const { api, s, done, colId, envId } = await setup(['--no-run']);
  try {
    const list = await s.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(!names.includes('run_request') && !names.includes('run_collection'));
    assert.ok(names.includes('list_requests') && names.includes('get_last_results'));
    for (const name of ['run_request', 'run_collection']) {
      const r = await s.call(name, { collection: colId, request: 'Basic/Ping', environment: envId });
      assert.equal(r.isError, true);
      assert.match(r.text, /--no-run/);
    }
    assert.equal(Object.keys(api.hits).length, 0);
    assert.ok(!s.stderr.includes('WARNING: --allow-any-host'), 'no network warning when run is disabled');
  } finally { await done(); }
});

test('--allow-host: allowed host works; other hosts (resolved variable, redirect, script call) are blocked before connecting', async () => {
  const { api, s, done, colId, envId } = await setup(['--allow-host', '127.0.0.1']);
  try {
    const ok = await s.call('run_request', { collection: colId, request: 'Basic/Ping', environment: envId });
    assert.equal(ok.data.result.status, 200);
    assert.equal(api.hits['/ping'], 1);

    // host coming from a variable, resolved at run time
    const hostile = await s.call('run_request', { collection: colId, request: 'Hostile', environment: envId });
    assert.ok(hostile.data.result.error, 'request to the forbidden host fails');
    assert.match(hostile.data.result.error, /allow-host|Blocked/i);
    assert.equal(api.hits['/hostile'] || 0, 0);

    // redirect to a different host name
    const red = await s.call('run_request', { collection: colId, request: 'Redirect', environment: envId });
    assert.equal(api.hits['/redirect'], 1);
    assert.ok(red.data.result.error || red.data.result.status !== 200);
    assert.equal(api.hits['/landed'] || 0, 0, 'the redirect target was never contacted');

    // pm.sendRequest from a script
    const script = await s.call('run_request', { collection: colId, request: 'ScriptCall', environment: envId });
    assert.equal(script.isError, false, script.text);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(api.hits['/from-script'] || 0, 0, 'script-initiated request was blocked');
    assert.match(s.stderr, /blocked outgoing connection to "localhost"/);
  } finally { await done(); }
});

test('--allow-any-host: the same requests go through (control) and a loud warning is printed', async () => {
  const { api, s, done, colId, envId } = await setup(['--allow-any-host']);
  try {
    const hostile = await s.call('run_request', { collection: colId, request: 'Hostile', environment: envId });
    assert.equal(hostile.data.result.status, 200);
    assert.equal(api.hits['/hostile'], 1);
    assert.match(s.stderr, /execution mode: run tools ENABLED FOR ALL HOSTS/);
    assert.match(s.stderr, /WARNING: --allow-any-host/);
  } finally { await done(); }
});

test('run tools are OFF by default: not listed, calls refused with the way to enable them, nothing sent', async () => {
  const { api, s, done, colId, envId } = await setup([], { runFlags: false });
  try {
    const names = (await s.request('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(!names.includes('run_request') && !names.includes('run_collection'));
    assert.ok(names.includes('get_last_results'));
    for (const name of ['run_request', 'run_collection']) {
      const r = await s.call(name, { collection: colId, request: 'Basic/Ping', environment: envId });
      assert.equal(r.isError, true);
      assert.match(r.text, /--allow-host/);
      assert.match(r.text, /--allow-any-host/);
    }
    assert.equal(Object.keys(api.hits).length, 0);
    assert.match(s.stderr, /execution mode: run tools NOT ENABLED/);
  } finally { await done(); }
});

test('startup states the execution mode on stderr: restricted hosts, all hosts, disabled', async () => {
  const a = await setup(['--allow-host', '127.0.0.1', '--allow-host', '*.example.com']);
  try { assert.match(a.s.stderr, /execution mode: run tools ENABLED, limited to hosts: 127\.0\.0\.1, \*\.example\.com/); } finally { await a.done(); }
  const b = await setup(['--no-run']);
  try { assert.match(b.s.stderr, /execution mode: run tools DISABLED \(--no-run\)/); } finally { await b.done(); }
});

test('--allow-any-host together with --allow-host, or with --no-run, refuses to start (exit 2)', async () => {
  for (const args of [['--allow-any-host', '--allow-host', 'a.com'], ['--no-run', '--allow-any-host']]) {
    const s = startServer(['--workspace', makeTmp(), ...args]);
    assert.equal((await s.close()).code, 2, args.join(' '));
    assert.match(s.stderr, /mutually exclusive|no effect/);
  }
});

test('agent data/variables cannot redirect a request (carrying a secret header) to another host', async () => {
  for (const flags of [[], ['--allow-host', '127.0.0.1'], ['--allow-any-host']]) {
    const attacker = await startFakeApi();
    const { api, s, done, colId, envId } = await setup(flags, { runFlags: flags.length > 0 });
    try {
      const r = await s.call('run_request', { collection: colId, request: 'Echo', environment: envId, data: { base: attacker.base } });
      assert.equal(r.isError, true, `flags=${flags.join(' ')}: ${r.text}`);
      assert.deepEqual(attacker.hits, {}, `flags=${flags.join(' ')}: the attacker server received a request`);
      assert.ok(!r.text.includes(ENV_SECRET));
      if (flags.length) {
        assert.match(r.text, /would change the target host/);
        // agent variables rank below the environment: they cannot move the request either
        const v = await s.call('run_request', { collection: colId, request: 'Echo', environment: envId, variables: { base: attacker.base } });
        assert.equal(v.data.result.status, 200);
        assert.deepEqual(attacker.hits, {});
        assert.equal(api.hits['/echo'], 1, 'the request still went to the environment host');
      }
    } finally { await done(); await attacker.close(); }
  }
});

test('without an environment baseline the --allow-host list stays the authority for a host chosen by the agent', async () => {
  const attacker = await startFakeApi();
  const { s, done, colId } = await setup(['--allow-host', '127.0.0.1']);
  try {
    const r = await s.call('run_request', { collection: colId, request: 'Echo', data: { base: `http://localhost:${new URL(attacker.base).port}`, apiToken: 'x', hidden: 'y' } });
    assert.ok(r.data.result.error, 'blocked at the socket layer');
    assert.deepEqual(attacker.hits, {});
  } finally { await done(); await attacker.close(); }
});

test('timeouts: a slow endpoint is cut at timeoutMs and the call returns with an error', async () => {
  const { s, done, colId, envId } = await setup();
  try {
    const t0 = Date.now();
    const r = await s.call('run_request', { collection: colId, request: 'Slow', environment: envId, timeoutMs: 1500 });
    assert.ok(Date.now() - t0 < 9000, 'returned well before the 10 s server delay');
    assert.equal(r.isError, false);
    assert.ok(r.data.result.error, 'request error reported');
  } finally { await done(); }
});

test('session budget: --max-requests refuses calls that would exceed it', async () => {
  const { s, done, colId, envId } = await setup(['--max-requests', '3'], { hostile: false });
  try {
    const big = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId, iterations: 2 });
    assert.equal(big.isError, true);
    assert.match(big.text, /budget/i);
    const ok = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId });
    assert.equal(ok.isError, false);
    assert.equal(ok.data.budget.requestsRemaining, 0);
    const again = await s.call('run_request', { collection: colId, request: 'Basic/Ping', environment: envId });
    assert.equal(again.isError, true);
    assert.match(again.text, /budget/i);
  } finally { await done(); }
});

test('per-call request cap', async () => {
  const { s, done, colId, envId } = await setup([], { hostile: false });
  try {
    const r = await s.call('run_collection', { collection: colId, folder: 'Many', environment: envId, iterations: 20 });
    assert.equal(r.isError, true);
    assert.match(r.text, /per-call limit/);
    const ok = await s.call('run_collection', { collection: colId, folder: 'Many', environment: envId, iterations: 2 });
    assert.equal(ok.data.summary.requests, 22);
  } finally { await done(); }
});

test('get_last_results: newest first, limited, filterable by runId', async () => {
  const { s, done, colId, envId } = await setup([], { hostile: false });
  try {
    const a = await s.call('run_request', { collection: colId, request: 'Basic/Ping', environment: envId });
    const b = await s.call('run_collection', { collection: colId, folder: 'Basic', environment: envId });
    const last = await s.call('get_last_results', { limit: 1 });
    assert.equal(last.data.runs.length, 1);
    assert.equal(last.data.runs[0].runId, b.data.runId);
    const one = await s.call('get_last_results', { runId: a.data.runId });
    assert.equal(one.data.runs.length, 1);
    assert.equal(one.data.runs[0].tool, 'run_request');
    assert.equal((await s.call('get_last_results', { limit: 11 })).isError, true);
  } finally { await done(); }
});

test('--include-credentials shows credentials but never secret-flagged values; warns on stderr', async () => {
  const { s, done, colId, envId } = await setup(['--include-credentials']);
  try {
    const r = await s.call('run_request', { collection: colId, request: 'Echo', environment: envId, maxBodyBytes: 65536 });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes(SECRET_TOKEN), 'non-flagged credentials are returned when asked');
    assert.ok(!r.text.includes(ENV_SECRET), 'secret-flagged environment values are never returned');
    assert.match(s.stderr, /--include-credentials is set/);
  } finally { await done(); }
});

test('a request-level timeout of 0 (or a huge one) cannot lengthen the session timeout: the call returns in time and the next run works', async () => {
  const { api, s, done, colId, envId } = await setup();
  try {
    for (const name of ['HangNoTimeout', 'HangLongTimeout']) {
      const t0 = Date.now();
      const r = await s.call('run_request', { collection: colId, request: name, environment: envId, timeoutMs: 1500 }, { timeoutMs: 9000 });
      assert.ok(Date.now() - t0 < 6000, `${name}: returned within the call timeout (took ${Date.now() - t0} ms)`);
      assert.equal(r.isError, false, r.text);
      assert.ok(r.data.result.error, `${name}: the hanging request is reported as an error`);
    }
    const next = await s.call('run_request', { collection: colId, request: 'Basic/Ping', environment: envId });
    assert.equal(next.data.result.status, 200);
    assert.equal(api.hits['/ping'], 1);
  } finally { await done(); }
});

test('a run stuck past the hard timeout (script request that never answers) is torn down: partial result, lock released, next run fine', async () => {
  const { api, s, done, colId, envId } = await setup();
  try {
    const t0 = Date.now();
    const r = await s.call('run_request', { collection: colId, request: 'HangScript', environment: envId, timeoutMs: 1000 }, { timeoutMs: 12000 });
    assert.ok(Date.now() - t0 < 8000, `returned in bounded time (took ${Date.now() - t0} ms)`);
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.timedOut, true);
    const next = await s.call('run_request', { collection: colId, request: 'Basic/Ping', environment: envId }, { timeoutMs: 8000 });
    assert.equal(next.isError, false, next.text);
    assert.equal(next.data.result.status, 200);
    assert.equal(api.hits['/ping'], 2);
  } finally { await done(); }
});
