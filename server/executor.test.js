'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { executeRequest, flattenItems, flattenItemsWithScripts, setExecutorConfig, resolveVariables, buildBody, buildProxyOption, applyAuth } = require('./executor');

async function withServer(handler, runTest) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/test`;

  try {
    await runTest(url);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
}

function makeContext() {
  return {
    environment: {},
    collectionVariables: {},
    globals: {},
    dataRow: {},
    collVars: [],
    cookies: {},
    collectionItems: [],
    conditionalExecution: true,
    mockBase: null,
  };
}

test('executeRequest routes new environment mutations from test scripts into updatedEnvironment', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (url) => {
    const item = {
      name: 'Env mutation request',
      request: { method: 'GET', url },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: ["apx.environment.set('brandNewVar', 'hello');"],
          },
        },
      ],
    };

    const result = await executeRequest(item, makeContext());

    assert.equal(result.error, null);
    assert.equal(result.updatedEnvironment.brandNewVar, 'hello');
    assert.equal(result.updatedCollectionVariables.brandNewVar, undefined);
  });
});

test('executeRequest keeps collection and generic variable mutations out of environment scope', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (url) => {
    const item = {
      name: 'Collection mutation request',
      request: { method: 'GET', url },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              "apx.collectionVariables.set('collectionOnly', 'c1');",
              "apx.variables.set('genericVar', 'g1');",
            ],
          },
        },
      ],
    };

    const result = await executeRequest(item, makeContext());

    assert.equal(result.error, null);
    assert.equal(result.updatedEnvironment.collectionOnly, undefined);
    assert.equal(result.updatedEnvironment.genericVar, undefined);
    assert.equal(result.updatedCollectionVariables.collectionOnly, 'c1');
    assert.equal(result.updatedCollectionVariables.genericVar, 'g1');
  });
});

function getEventExec(item, listen) {
  const event = (item.event || []).find(e => e.listen === listen);
  return event ? event.script.exec.join('\n') : null;
}

test('flattenItemsWithScripts merges prerequest/test scripts in collection→folder→request order', () => {
  const collectionEvents = [
    { listen: 'prerequest', script: { exec: ["pm.variables.set('scope', 'collection-prereq');"] } },
    { listen: 'test', script: { exec: ["pm.variables.set('scope', 'collection-test');"] } },
  ];

  const items = [
    {
      name: 'Folder A',
      event: [
        { listen: 'prerequest', script: { exec: ["pm.variables.set('scope', 'folder-a-prereq');"] } },
        { listen: 'test', script: { exec: ["pm.variables.set('scope', 'folder-a-test');"] } },
      ],
      item: [
        {
          name: 'Folder B',
          event: [
            { listen: 'prerequest', script: { exec: ["pm.variables.set('scope', 'folder-b-prereq');"] } },
            { listen: 'test', script: { exec: ["pm.variables.set('scope', 'folder-b-test');"] } },
          ],
          item: [
            {
              name: 'Leaf Request',
              request: { method: 'GET', url: 'https://example.com' },
              event: [
                { listen: 'prerequest', script: { exec: ["pm.variables.set('scope', 'request-prereq');"] } },
                { listen: 'test', script: { exec: ["pm.variables.set('scope', 'request-test');"] } },
              ],
            },
          ],
        },
      ],
    },
  ];

  const [leaf] = flattenItemsWithScripts(items, collectionEvents);
  assert.equal(
    getEventExec(leaf, 'prerequest'),
    [
      "pm.variables.set('scope', 'collection-prereq');",
      "pm.variables.set('scope', 'folder-a-prereq');",
      "pm.variables.set('scope', 'folder-b-prereq');",
      "pm.variables.set('scope', 'request-prereq');",
    ].join('\n\n')
  );
  assert.equal(
    getEventExec(leaf, 'test'),
    [
      "pm.variables.set('scope', 'collection-test');",
      "pm.variables.set('scope', 'folder-a-test');",
      "pm.variables.set('scope', 'folder-b-test');",
      "pm.variables.set('scope', 'request-test');",
    ].join('\n\n')
  );
});

test('flattenItemsWithScripts applies ancestor scripts to leaves without own prerequest/test scripts', () => {
  const collectionEvents = [
    { listen: 'prerequest', script: { exec: ['collection-prerequest();'] } },
    { listen: 'test', script: { exec: ['collection-test();'] } },
  ];
  const items = [
    {
      name: 'Folder',
      event: [
        { listen: 'prerequest', script: { exec: ['folder-prerequest();'] } },
        { listen: 'test', script: { exec: ['folder-test();'] } },
      ],
      item: [
        {
          name: 'Leaf Request Without Own Scripts',
          request: { method: 'GET', url: 'https://example.com' },
        },
      ],
    },
  ];

  const [leaf] = flattenItemsWithScripts(items, collectionEvents);
  assert.equal(getEventExec(leaf, 'prerequest'), 'collection-prerequest();\n\nfolder-prerequest();');
  assert.equal(getEventExec(leaf, 'test'), 'collection-test();\n\nfolder-test();');
});

test('flattenItemsWithScripts preserves non-prerequest/test leaf events', () => {
  const nonScriptEvent = { listen: 'console', script: { exec: ["console.log('keep me');"] } };
  const items = [
    {
      name: 'Leaf Request',
      request: { method: 'GET', url: 'https://example.com' },
      event: [
        nonScriptEvent,
        { listen: 'prerequest', script: { exec: ['leaf-prerequest();'] } },
      ],
    },
  ];
  const collectionEvents = [{ listen: 'prerequest', script: { exec: ['collection-prerequest();'] } }];

  const [leaf] = flattenItemsWithScripts(items, collectionEvents);
  const preserved = (leaf.event || []).find(e => e.listen === 'console');
  assert.deepEqual(preserved, nonScriptEvent);
  assert.equal(getEventExec(leaf, 'prerequest'), 'collection-prerequest();\n\nleaf-prerequest();');
});

// ─── flattenItems ─────────────────────────────────────────────────────────────

test('flattenItems returns only leaf items with requests', () => {
  const items = [
    { name: 'Req1', request: { method: 'GET', url: 'https://a.com' } },
    {
      name: 'Folder',
      item: [
        { name: 'Req2', request: { method: 'POST', url: 'https://b.com' } },
        {
          name: 'SubFolder',
          item: [
            { name: 'Req3', request: { method: 'DELETE', url: 'https://c.com' } },
          ],
        },
      ],
    },
  ];
  const result = flattenItems(items);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(r => r.name), ['Req1', 'Req2', 'Req3']);
});

test('flattenItems ignores folder nodes (items with no request)', () => {
  const items = [
    { name: 'EmptyFolder', item: [] },
    { name: 'Req', request: { method: 'GET', url: 'https://a.com' } },
  ];
  const result = flattenItems(items);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Req');
});

test('flattenItems returns empty array for empty input', () => {
  assert.deepEqual(flattenItems([]), []);
});

// ─── resolveVariables ────────────────────────────────────────────────────────

test('resolveVariables substitutes a known variable', () => {
  assert.equal(resolveVariables('Hello {{name}}', { name: 'World' }), 'Hello World');
});

test('resolveVariables leaves unknown variables as-is', () => {
  assert.equal(resolveVariables('Hello {{unknown}}', {}), 'Hello {{unknown}}');
});

test('resolveVariables handles multiple placeholders in one string', () => {
  assert.equal(
    resolveVariables('{{proto}}://{{host}}/path', { proto: 'https', host: 'example.com' }),
    'https://example.com/path'
  );
});

test('resolveVariables returns non-string input unchanged', () => {
  assert.equal(resolveVariables(42, {}), 42);
  assert.equal(resolveVariables(null, {}), null);
  assert.equal(resolveVariables(undefined, {}), undefined);
});

test('resolveVariables handles whitespace inside placeholder', () => {
  assert.equal(resolveVariables('{{ name }}', { name: 'Alice' }), 'Alice');
});

// ─── buildBody ───────────────────────────────────────────────────────────────

test('buildBody returns undefined when body is null or mode is none', () => {
  assert.equal(buildBody(null, {}, {}), undefined);
  assert.equal(buildBody({ mode: 'none' }, {}, {}), undefined);
});

test('buildBody raw mode returns resolved string and sets Content-Type text/plain', () => {
  const headers = {};
  const result = buildBody({ mode: 'raw', raw: 'hello {{who}}' }, headers, { who: 'world' });
  assert.equal(result, 'hello world');
  assert.equal(headers['Content-Type'], 'text/plain');
});

test('buildBody raw mode detects json language and sets Content-Type application/json', () => {
  const headers = {};
  buildBody({ mode: 'raw', raw: '{}', options: { raw: { language: 'json' } } }, headers, {});
  assert.equal(headers['Content-Type'], 'application/json');
});

test('buildBody raw mode does not overwrite explicit Content-Type header', () => {
  const headers = { 'Content-Type': 'application/octet-stream' };
  buildBody({ mode: 'raw', raw: 'data' }, headers, {});
  assert.equal(headers['Content-Type'], 'application/octet-stream');
});

test('buildBody urlencoded mode encodes params and skips disabled entries', () => {
  const headers = {};
  const result = buildBody({
    mode: 'urlencoded',
    urlencoded: [
      { key: 'a', value: '1' },
      { key: 'b', value: '2', disabled: true },
      { key: 'c', value: '{{val}}' },
    ],
  }, headers, { val: '3' });
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(result);
  assert.equal(params.get('a'), '1');
  assert.equal(params.get('b'), null);
  assert.equal(params.get('c'), '3');
});

test('buildBody graphql mode wraps query + variables in JSON', () => {
  const headers = {};
  const result = buildBody({
    mode: 'graphql',
    graphql: { query: 'query { me }', variables: '{"id":1}' },
  }, headers, {});
  assert.equal(headers['Content-Type'], 'application/json');
  const parsed = JSON.parse(result);
  assert.equal(parsed.query, 'query { me }');
  assert.deepEqual(parsed.variables, { id: 1 });
});

test('buildBody graphql mode handles invalid variables JSON gracefully', () => {
  const headers = {};
  const result = buildBody({
    mode: 'graphql',
    graphql: { query: 'query { me }', variables: 'not-json' },
  }, headers, {});
  const parsed = JSON.parse(result);
  assert.equal(parsed.query, 'query { me }');
  assert.equal(parsed.variables, undefined);
});

// ─── buildProxyOption ────────────────────────────────────────────────────────

test('buildProxyOption returns undefined for falsy proxyUrl', () => {
  assert.equal(buildProxyOption(null, 'https://target.com'), undefined);
  assert.equal(buildProxyOption('', 'https://target.com'), undefined);
});

test('buildProxyOption parses proxy URL into host/port/protocol', () => {
  const result = buildProxyOption('http://proxy.corp.com:8080', 'https://target.com');
  assert.equal(result.protocol, 'http');
  assert.equal(result.host, 'proxy.corp.com');
  assert.equal(result.port, 8080);
});

test('buildProxyOption defaults port to 80 for http proxy when no port is given', () => {
  const result = buildProxyOption('http://proxy.internal', 'https://target.com');
  assert.equal(result.port, 80);
});

test('buildProxyOption defaults port to 443 for https proxy', () => {
  const result = buildProxyOption('https://proxy.internal', 'https://target.com');
  assert.equal(result.port, 443);
});

test('buildProxyOption includes auth when proxy has credentials', () => {
  const result = buildProxyOption('http://user:pass@proxy.corp.com:8080', 'https://target.com');
  assert.equal(result.auth.username, 'user');
  assert.equal(result.auth.password, 'pass');
});

test('buildProxyOption returns undefined when target is in noProxy list', () => {
  setExecutorConfig({ noProxy: 'internal.corp.com,localhost' });
  const result = buildProxyOption('http://proxy.corp.com:8080', 'https://internal.corp.com/api');
  assert.equal(result, undefined);
  setExecutorConfig({ noProxy: '' });
});

test('buildProxyOption proxies target not in noProxy list', () => {
  setExecutorConfig({ noProxy: 'internal.corp.com' });
  const result = buildProxyOption('http://proxy.corp.com:8080', 'https://external.host.com/api');
  assert.ok(result !== undefined);
  setExecutorConfig({ noProxy: '' });
});

// ─── applyAuth ───────────────────────────────────────────────────────────────

test('applyAuth bearer sets Authorization header', async () => {
  const headers = {};
  await applyAuth({ type: 'bearer', bearer: [{ key: 'token', value: 'mytoken' }] }, headers, {});
  assert.equal(headers['Authorization'], 'Bearer mytoken');
});

test('applyAuth bearer resolves variables in token', async () => {
  const headers = {};
  await applyAuth({ type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] }, headers, { tok: 'resolved' });
  assert.equal(headers['Authorization'], 'Bearer resolved');
});

test('applyAuth basic encodes credentials as base64', async () => {
  const headers = {};
  await applyAuth({
    type: 'basic',
    basic: [
      { key: 'username', value: 'alice' },
      { key: 'password', value: 'secret' },
    ],
  }, headers, {});
  const expected = 'Basic ' + Buffer.from('alice:secret').toString('base64');
  assert.equal(headers['Authorization'], expected);
});

test('applyAuth apikey header mode sets custom header', async () => {
  const headers = {};
  await applyAuth({
    type: 'apikey',
    apikey: [
      { key: 'key', value: 'X-API-Key' },
      { key: 'value', value: 'abc123' },
      { key: 'in', value: 'header' },
    ],
  }, headers, {});
  assert.equal(headers['X-API-Key'], 'abc123');
});

test('applyAuth noauth does not modify headers', async () => {
  const headers = {};
  await applyAuth({ type: 'noauth' }, headers, {});
  assert.deepEqual(headers, {});
});

test('applyAuth null auth does not modify headers', async () => {
  const headers = {};
  await applyAuth(null, headers, {});
  assert.deepEqual(headers, {});
});
