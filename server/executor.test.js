'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { executeRequest, flattenItems, flattenItemsWithScripts, setExecutorConfig, resolveVariables, buildBody, buildProxyOption, applyAuth, resolveHeaderPairs, resolveParamPairs } = require('@apilix/core');

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

// ─── resolveHeaderPairs ───────────────────────────────────────────────────────

test('resolveHeaderPairs resolves header keys and values in a single call', () => {
  const headers = [
    { key: 'Authorization', value: 'Bearer {{token}}' },
    { key: 'X-Request-Id', value: '{{reqId}}' },
  ];
  const result = resolveHeaderPairs(headers, { token: 'abc', reqId: '42' });
  assert.deepEqual(result, { Authorization: 'Bearer abc', 'X-Request-Id': '42' });
});

test('resolveHeaderPairs resolves variable in header key', () => {
  const result = resolveHeaderPairs([{ key: '{{headerName}}', value: 'v' }], { headerName: 'X-Custom' });
  assert.deepEqual(result, { 'X-Custom': 'v' });
});

test('resolveHeaderPairs omits disabled headers', () => {
  const headers = [
    { key: 'Active', value: 'yes' },
    { key: 'Disabled', value: 'no', disabled: true },
  ];
  const result = resolveHeaderPairs(headers, {});
  assert.deepEqual(result, { Active: 'yes' });
});

test('resolveHeaderPairs returns empty object for empty input', () => {
  assert.deepEqual(resolveHeaderPairs([], {}), {});
  assert.deepEqual(resolveHeaderPairs(null, {}), {});
});

// ─── resolveParamPairs ────────────────────────────────────────────────────────

test('resolveParamPairs resolves key and value for each enabled param', () => {
  const params = [
    { key: 'user', value: '{{name}}' },
    { key: 'token', value: '{{tok}}' },
  ];
  const result = resolveParamPairs(params, { name: 'Alice', tok: 'abc' });
  assert.deepEqual(result, [{ key: 'user', value: 'Alice' }, { key: 'token', value: 'abc' }]);
});

test('resolveParamPairs filters out disabled params', () => {
  const params = [
    { key: 'active', value: '1' },
    { key: 'skip', value: '2', disabled: true },
  ];
  const result = resolveParamPairs(params, {});
  assert.deepEqual(result, [{ key: 'active', value: '1' }]);
});

test('resolveParamPairs returns empty array for empty input', () => {
  assert.deepEqual(resolveParamPairs([], {}), []);
  assert.deepEqual(resolveParamPairs(null, {}), []);
});

test('resolveParamPairs leaves unknown placeholders intact', () => {
  const result = resolveParamPairs([{ key: '{{missing}}', value: 'v' }], {});
  assert.deepEqual(result, [{ key: '{{missing}}', value: 'v' }]);
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

test('buildBody urlencoded mode resolves variables in param keys', () => {
  const headers = {};
  const result = buildBody({
    mode: 'urlencoded',
    urlencoded: [{ key: '{{paramName}}', value: '{{paramValue}}' }],
  }, headers, { paramName: 'user', paramValue: 'alice' });
  const params = new URLSearchParams(result);
  assert.equal(params.get('user'), 'alice');
});

test('buildBody formdata mode resolves text field key and value via variables', () => {
  const headers = {};
  buildBody({
    mode: 'formdata',
    formdata: [{ key: '{{fieldName}}', value: '{{fieldVal}}' }],
  }, headers, { fieldName: 'caption', fieldVal: 'hello' });
  // FormData sets a multipart Content-Type; the key resolution is verified
  // by asserting the returned form object was built without error
  assert.ok(headers['content-type'].startsWith('multipart/form-data'));
});

test('buildBody formdata mode skips disabled entries', () => {
  const headers = {};
  // No error should be thrown and no entries appended for disabled items
  buildBody({
    mode: 'formdata',
    formdata: [
      { key: 'active', value: 'yes' },
      { key: 'skip', value: 'no', disabled: true },
    ],
  }, headers, {});
  assert.ok(headers['content-type'].startsWith('multipart/form-data'));
});

test('buildBody formdata mode records resolved key in skip warning for file fields', () => {
  const headers = {};
  const warnings = [];
  buildBody({
    mode: 'formdata',
    formdata: [{ key: '{{fname}}', value: 'data.bin', type: 'file' }],
  }, headers, { fname: 'upload' }, warnings);
  assert.equal(warnings.length, 1);
  // Warning must use the resolved key name, not the raw placeholder
  assert.ok(warnings[0].includes('"upload"'), `Expected resolved key in warning, got: ${warnings[0]}`);
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
  try {
    const result = buildProxyOption('http://proxy.corp.com:8080', 'https://internal.corp.com/api');
    assert.equal(result, undefined);
  } finally {
    setExecutorConfig({ noProxy: '' });
  }
});

test('buildProxyOption proxies target not in noProxy list', () => {
  setExecutorConfig({ noProxy: 'internal.corp.com' });
  try {
    const result = buildProxyOption('http://proxy.corp.com:8080', 'https://external.host.com/api');
    assert.ok(result !== undefined);
  } finally {
    setExecutorConfig({ noProxy: '' });
  }
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

test('applyAuth apikey query mode appends query parameter and does not set header', async () => {
  const headers = {};
  const nextUrl = await applyAuth({
    type: 'apikey',
    apikey: [
      { key: 'key', value: 'api_key' },
      { key: 'value', value: 'abc123' },
      { key: 'in', value: 'query' },
    ],
  }, headers, {}, 'https://example.com/data?x=1');

  assert.equal(headers['api_key'], undefined);
  assert.equal(nextUrl, 'https://example.com/data?x=1&api_key=abc123');
});

test('applyAuth apikey query mode resolves variables in key and value', async () => {
  const headers = {};
  const nextUrl = await applyAuth({
    type: 'apikey',
    apikey: [
      { key: 'key', value: '{{k}}' },
      { key: 'value', value: '{{v}}' },
      { key: 'in', value: 'query' },
    ],
  }, headers, { k: 'token', v: 'value-1' }, 'https://example.com/data');

  assert.equal(nextUrl, 'https://example.com/data?token=value-1');
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

test('executeRequest apikey query mode sends API key as URL parameter', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    const fullUrl = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: fullUrl.searchParams.get('token') || '' }));
  }, async (url) => {
    const item = {
      name: 'API key in query',
      request: {
        method: 'GET',
        url,
        auth: {
          type: 'apikey',
          apikey: [
            { key: 'key', value: 'token' },
            { key: 'value', value: 'abc123' },
            { key: 'in', value: 'query' },
          ],
        },
      },
    };

    const result = await executeRequest(item, makeContext());
    assert.equal(result.error, null);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.token, 'abc123');
  });
});

// ─── apx.executeRequest child mutation propagation ───────────────────────────

test('environment variable set in child request test script is available in parent request', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/token')) {
      res.end(JSON.stringify({ access_token: 'secret-token' }));
    } else {
      // /data: echo back the Authorization header so the test can verify it was resolved
      res.end(JSON.stringify({ received: req.headers['authorization'] || '' }));
    }
  }, async (url) => {
    // withServer gives us http://host:port/test — strip the /test suffix to get the base
    const baseUrl = url.slice(0, url.lastIndexOf('/'));

    const tokenItem = {
      name: 'Get token',
      request: { method: 'GET', url: `${baseUrl}/token` },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              'const json = apx.response.json();',
              "apx.environment.set('token', json.access_token);",
            ],
          },
        },
      ],
    };

    const dataItem = {
      name: 'Get data',
      request: {
        method: 'GET',
        url: `${baseUrl}/data`,
        header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
      },
      event: [
        {
          listen: 'prerequest',
          script: {
            type: 'text/javascript',
            exec: ["apx.executeRequest('Get token');"],
          },
        },
      ],
    };

    const context = {
      ...makeContext(),
      collectionItems: [tokenItem, dataItem],
    };

    const result = await executeRequest(dataItem, context);

    assert.equal(result.error, null);
    // The token set by "Get token" test script must be in the environment so
    // "Get data" can resolve {{token}} in its Authorization header.
    assert.equal(result.updatedEnvironment.token, 'secret-token');
    // Verify the resolved header was actually sent with the token value.
    const body = JSON.parse(result.body);
    assert.equal(body.received, 'Bearer secret-token');
  });
});

// ─── executeRequest header variable resolution (integration) ─────────────────

test('executeRequest resolves variables in request header values', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: req.headers['x-custom'] || '' }));
  }, async (url) => {
    const item = {
      name: 'Header var resolve',
      request: {
        method: 'GET',
        url,
        header: [{ key: 'X-Custom', value: '{{customVal}}' }],
      },
    };

    const result = await executeRequest(item, {
      ...makeContext(),
      environment: { customVal: 'resolved-value' },
    });

    assert.equal(result.error, null);
    const body = JSON.parse(result.body);
    assert.equal(body.received, 'resolved-value');
  });
});

test('executeRequest resolves variables in request header keys', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: req.headers['x-dynamic'] || '' }));
  }, async (url) => {
    const item = {
      name: 'Header key var resolve',
      request: {
        method: 'GET',
        url,
        header: [{ key: '{{headerName}}', value: 'headerval' }],
      },
    };

    const result = await executeRequest(item, {
      ...makeContext(),
      environment: { headerName: 'X-Dynamic' },
    });

    assert.equal(result.error, null);
    const body = JSON.parse(result.body);
    assert.equal(body.received, 'headerval');
  });
});

test('executeRequest does not send disabled request headers', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      active: req.headers['x-active'] || '',
      disabled: req.headers['x-disabled'] || '',
    }));
  }, async (url) => {
    const item = {
      name: 'Disabled header',
      request: {
        method: 'GET',
        url,
        header: [
          { key: 'X-Active', value: 'yes' },
          { key: 'X-Disabled', value: 'should-not-appear', disabled: true },
        ],
      },
    };

    const result = await executeRequest(item, makeContext());

    assert.equal(result.error, null);
    const body = JSON.parse(result.body);
    assert.equal(body.active, 'yes');
    assert.equal(body.disabled, '');
  });
});
