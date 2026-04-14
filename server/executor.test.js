'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { executeRequest, flattenItemsWithScripts, setExecutorConfig } = require('./executor');

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
