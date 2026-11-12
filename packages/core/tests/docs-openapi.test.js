'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDocs, toYaml } = require('../src/docs');
const { makeCollection, SECRETS } = require('./docs-fixtures');

const gen = (opts, col = makeCollection()) => generateDocs(col, Object.assign({ format: 'openapi' }, opts));

test('openapi 3.0.3 default, valid JSON output', () => {
  const r = gen();
  assert.equal(r.extension, 'json');
  const spec = JSON.parse(r.content);
  assert.equal(spec.openapi, '3.0.3');
  assert.equal(spec.info.title, 'Demo <API>');
  assert.deepEqual(r.spec, spec);
});

test('3.1 flag', () => {
  assert.equal(gen({ openapiVersion: '3.1.0' }).spec.openapi, '3.1.0');
});

test('paths: :id and {{var}} become {param}, parameters declared', () => {
  const { spec } = gen();
  const op = spec.paths['/users/{id}'].get;
  assert.equal(op.operationId, 'getUser');
  assert.deepEqual(op.tags, ['Users']);
  const id = op.parameters.find(p => p.name === 'id');
  assert.equal(id.in, 'path');
  assert.equal(id.required, true);
  assert.equal(id.example, '42');
  assert.ok(op.parameters.find(p => p.name === 'page' && p.in === 'query'));
  const tok = op.parameters.find(p => p.name === 'token');
  assert.equal(tok.example, undefined, 'redacted value must not become an example');
  assert.ok(!op.parameters.find(p => p.name.toLowerCase() === 'authorization'));
  assert.ok(op.parameters.find(p => p.name === 'X-Trace'));
  assert.ok(!op.parameters.find(p => p.name === 'X-Disabled'));
});

test('{{var}} in path segments becomes a path parameter', () => {
  const col = makeCollection();
  col.item[1].request.url = 'https://other.example.org/v/{{version}}/health';
  const { spec } = gen({}, col);
  const op = spec.paths['/v/{version}/health'].get;
  assert.equal(op.parameters[0].name, 'version');
});

test('servers grouped by host; variables templated; operation servers when multiple', () => {
  const { spec } = gen();
  assert.deepEqual(spec.servers.map(s => s.url), ['{baseUrl}', 'https://other.example.org']);
  assert.equal(spec.servers[0].variables.baseUrl.default, 'https://api.example.com');
  assert.deepEqual(spec.paths['/health'].get.servers, [{ url: 'https://other.example.org' }]);
  assert.deepEqual(spec.paths['/users'].post.servers.map(s => s.url), ['{baseUrl}']);
});

test('requestBody from raw JSON infers schema, redacts secret keys', () => {
  const { spec, } = gen();
  const media = spec.paths['/users'].post.requestBody.content['application/json'];
  assert.equal(media.schema.type, 'object');
  assert.equal(media.schema.properties.name.type, 'string');
  assert.equal(media.example.api_key, '<redacted>');
});

test('requestBody modes: urlencoded, formdata, graphql, file', () => {
  const col = makeCollection();
  const mk = (name, body) => col.item.push({ name, request: { method: 'POST', url: `https://x.test/${name}`, body } });
  mk('ue', { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] });
  mk('fd', { mode: 'formdata', formdata: [{ key: 'f', type: 'file', value: '' }, { key: 't', value: 'x' }] });
  mk('gq', { mode: 'graphql', graphql: { query: '{ me }', variables: '{"a":1}' } });
  mk('fl', { mode: 'file' });
  const { spec } = gen({}, col);
  assert.ok(spec.paths['/ue'].post.requestBody.content['application/x-www-form-urlencoded']);
  const fd = spec.paths['/fd'].post.requestBody.content['multipart/form-data'];
  assert.equal(fd.schema.properties.f.format, 'binary');
  assert.deepEqual(spec.paths['/gq'].post.requestBody.content['application/json'].example, { query: '{ me }', variables: { a: 1 } });
  assert.ok(spec.paths['/fl'].post.requestBody.content['application/octet-stream']);
});

test('responses come from examples; default when none', () => {
  const { spec } = gen();
  const get = spec.paths['/users/{id}'].get;
  assert.deepEqual(Object.keys(get.responses), ['200', '404']);
  const ex = get.responses['200'].content['application/json'].examples.Found.value;
  assert.equal(ex.password, '<redacted>');
  assert.ok(spec.paths['/users'].post.responses.default);
});

test('securitySchemes and security: collection, request override, noauth', () => {
  const { spec } = gen();
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  assert.deepEqual(spec.components.securitySchemes.bearerAuth, { type: 'http', scheme: 'bearer' });
  assert.deepEqual(spec.components.securitySchemes.apiKeyAuth, { type: 'apiKey', in: 'header', name: 'X-Key' });
  assert.deepEqual(spec.paths['/users/{id}'].get.security, [{ apiKeyAuth: [] }]);
  assert.equal(spec.paths['/users'].post.security, undefined);
  assert.deepEqual(spec.paths['/health'].get.security, []);
});

test('oauth2 client_credentials maps to flows', () => {
  const col = makeCollection();
  col.auth = { type: 'oauth2', oauth2: { grantType: 'client_credentials', clientId: 'cid', clientSecret: 'SECRET-OAUTH', tokenUrl: 'https://auth.test/token', scopes: ['read'] } };
  const r = gen({}, col);
  assert.deepEqual(r.spec.components.securitySchemes.oauth2Auth.flows.clientCredentials, { tokenUrl: 'https://auth.test/token', scopes: { read: '' } });
  assert.deepEqual(r.spec.security, [{ oauth2Auth: ['read'] }]);
  assert.ok(!r.content.includes('SECRET-OAUTH'));
});

test('unique operationIds, duplicate operations and unsupported methods warn', () => {
  const col = makeCollection();
  col.item.push({ name: 'Get user', request: { method: 'GET', url: '{{baseUrl}}/other' } });
  col.item.push({ name: 'Dup', request: { method: 'GET', url: '{{baseUrl}}/other' } });
  col.item.push({ name: 'Weird', request: { method: 'PROPFIND', url: '{{baseUrl}}/w' } });
  const r = gen({}, col);
  assert.equal(r.spec.paths['/other'].get.operationId, 'getUser2');
  assert.ok(r.warnings.some(w => /duplicate operation GET \/other/.test(w)));
  assert.ok(r.warnings.some(w => /PROPFIND/.test(w)));
  const ids = Object.values(r.spec.paths).flatMap(p => Object.values(p)).map(o => o.operationId);
  assert.equal(new Set(ids).size, ids.length);
});

test('yaml output is valid-looking and never leaks secrets', () => {
  const r = gen({ openapiFormat: 'yaml' });
  assert.equal(r.extension, 'yaml');
  assert.match(r.content, /^openapi: "3\.0\.3"\n/);
  assert.match(r.content, /\n {2}"\/users\/\{id\}":\n/);
  for (const s of SECRETS) assert.ok(!r.content.includes(s), `${s} leaked`);
});

test('toYaml serializer', () => {
  assert.equal(toYaml({ a: 1, b: 'x y', c: [1, { d: true }], e: {}, f: [], g: null, h: 'true', i: 'a\nb' }),
    'a: 1\nb: "x y"\nc:\n  - 1\n  - d: true\ne: {}\nf: []\ng: null\nh: "true"\ni: "a\\nb"\n');
  assert.equal(toYaml({ '/p/{id}': { get: {} } }), '"/p/{id}":\n  get: {}\n');
});

test('output is deterministic', () => {
  assert.equal(gen().content, gen().content);
  assert.equal(gen({ openapiFormat: 'yaml' }).content, gen({ openapiFormat: 'yaml' }).content);
});
