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
      { name: 'Mongo', request: { method: 'GET', url: 'x', requestType: 'mongodb', mongodb: {} } },
      { name: 'Many', id: 'folder-many', item: Array.from({ length: 11 }, (_, i) => get(`M${i}`, '/m')) },
      ...(withHostile ? [
        { ...get('Hostile', '/ping'), request: { method: 'GET', url: '{{evilBase}}/hostile' } },
        { ...get('ScriptCall', '/ping'), event: [{ listen: 'test', script: { exec: ['apx.sendRequest("{{evilBase}}/from-script", function () {});'.replace('{{evilBase}}', `http://localhost:${new URL(api.base).port}`)] } }] },
      ] : []),
    ],
  };
}

async function setup(extraArgs = [], { hostile = true } = {}) {
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
  const s = startServer(['--workspace', dir, ...extraArgs]);
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
    assert.ok(!s.stderr.includes('ANY host'), 'no network warning when run is disabled');
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

test('without --allow-host the same requests go through (control) and a warning is printed', async () => {
  const { api, s, done, colId, envId } = await setup();
  try {
    const hostile = await s.call('run_request', { collection: colId, request: 'Hostile', environment: envId });
    assert.equal(hostile.data.result.status, 200);
    assert.equal(api.hits['/hostile'], 1);
    assert.match(s.stderr, /run tools can reach ANY host/);
  } finally { await done(); }
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
