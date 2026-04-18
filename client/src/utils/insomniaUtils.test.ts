import { describe, it, expect, vi } from 'vitest';
import { isInsomniaExport, parseInsomniaExport, parseInsomniaV5Export, tryParseInsomniaText } from './insomniaUtils';

let mockGenerateIdCounter = 0;  

vi.mock('../store', () => ({  
  generateId: () => `mock-id-${++mockGenerateIdCounter}`,  
}));  


// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWorkspace(id = 'wrk_1', name = 'My API') {
  return { _id: id, _type: 'workspace' as const, parentId: null, name };
}

function makeRequest(opts: {
  id?: string;
  parentId?: string;
  name?: string;
  method?: string;
  url?: string;
  headers?: Array<{ name: string; value: string; disabled?: boolean }>;
  parameters?: Array<{ name: string; value: string; disabled?: boolean }>;
  body?: { mimeType?: string; text?: string; params?: Array<{ name: string; value: string; disabled?: boolean }> };
  authentication?: Record<string, unknown>;
  description?: string;
}) {
  return {
    _id: opts.id ?? 'req_1',
    _type: 'request' as const,
    parentId: opts.parentId ?? 'wrk_1',
    name: opts.name ?? 'Test Request',
    method: opts.method ?? 'GET',
    url: opts.url ?? 'https://api.example.com/users',
    ...(opts.headers && { headers: opts.headers }),
    ...(opts.parameters && { parameters: opts.parameters }),
    ...(opts.body && { body: opts.body }),
    ...(opts.authentication && { authentication: opts.authentication }),
    ...(opts.description && { description: opts.description }),
  };
}

function makeGroup(id: string, parentId: string, name: string) {
  return { _id: id, _type: 'request_group' as const, parentId, name };
}

function makeEnvironment(id: string, parentId: string, name: string, data?: Record<string, unknown>) {
  return { _id: id, _type: 'environment' as const, parentId, name, ...(data && { data }) };
}

function makeExport(resources: unknown[]) {
  return { __export_format: 4, resources };
}

// ─── isInsomniaExport ─────────────────────────────────────────────────────────

describe('isInsomniaExport', () => {
  it('returns false for null', () => {
    expect(isInsomniaExport(null)).toBe(false);
  });

  it('returns false for a plain string', () => {
    expect(isInsomniaExport('hello')).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isInsomniaExport({})).toBe(false);
  });

  it('returns false for Postman collection JSON', () => {
    const postman = {
      info: { name: 'My API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [],
    };
    expect(isInsomniaExport(postman)).toBe(false);
  });

  it('returns false when __export_format is 3', () => {
    expect(isInsomniaExport({ __export_format: 3, resources: [] })).toBe(false);
  });

  it('returns false when resources is not an array', () => {
    expect(isInsomniaExport({ __export_format: 4, resources: 'nope' })).toBe(false);
  });

  it('returns true for a minimal valid v4 export', () => {
    expect(isInsomniaExport({ __export_format: 4, resources: [] })).toBe(true);
  });

  it('returns true for a full v4 export with resources', () => {
    const exp = makeExport([makeWorkspace()]);
    expect(isInsomniaExport(exp)).toBe(true);
  });
});

// ─── parseInsomniaExport — error cases ───────────────────────────────────────

describe('parseInsomniaExport — error cases', () => {
  it('throws for non-Insomnia input', () => {
    expect(() => parseInsomniaExport({ foo: 'bar' })).toThrow();
  });

  it('throws for v3 export', () => {
    expect(() => parseInsomniaExport({ __export_format: 3, resources: [] })).toThrow();
  });
});

// ─── parseInsomniaExport — workspaces & requests ─────────────────────────────

describe('parseInsomniaExport — workspaces and requests', () => {
  it('produces one empty collection for a workspace with no requests', () => {
    const { collections, environments } = parseInsomniaExport(makeExport([makeWorkspace()]));
    expect(collections).toHaveLength(1);
    expect(collections[0].info.name).toBe('My API');
    expect(collections[0].item).toHaveLength(0);
    expect(environments).toHaveLength(0);
  });

  it('produces one collection with flat requests', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1', 'Demo API'),
      makeRequest({ id: 'req_1', parentId: 'wrk_1', name: 'Get Users', method: 'GET', url: 'https://api.example.com/users' }),
      makeRequest({ id: 'req_2', parentId: 'wrk_1', name: 'Create User', method: 'POST', url: 'https://api.example.com/users' }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    expect(collections).toHaveLength(1);
    expect(collections[0].item).toHaveLength(2);
    expect(collections[0].item[0].name).toBe('Get Users');
    expect(collections[0].item[0].request?.method).toBe('GET');
    expect(collections[0].item[1].name).toBe('Create User');
  });

  it('maps url as CollectionUrl raw field', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ url: 'https://api.example.com/users/{{id}}' }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    const url = collections[0].item[0].request?.url;
    expect(typeof url).toBe('object');
    expect((url as { raw: string }).raw).toBe('https://api.example.com/users/{{id}}');
  });

  it('produces one collection per workspace', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1', 'Alpha'),
      makeWorkspace('wrk_2', 'Beta'),
      makeRequest({ parentId: 'wrk_1' }),
      makeRequest({ id: 'req_2', parentId: 'wrk_2', name: 'Beta Request' }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    expect(collections).toHaveLength(2);
    const names = collections.map(c => c.info.name);
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
  });

  it('assigns the Postman v2.1 schema string to each collection', () => {
    const { collections } = parseInsomniaExport(makeExport([makeWorkspace()]));
    expect(collections[0].info.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    );
  });
});

// ─── parseInsomniaExport — nested request groups ──────────────────────────────

describe('parseInsomniaExport — nested request_groups', () => {
  it('creates folder items for request_groups', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeGroup('fld_1', 'wrk_1', 'Users'),
      makeRequest({ id: 'req_1', parentId: 'fld_1', name: 'List Users' }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    expect(collections[0].item).toHaveLength(1);
    const folder = collections[0].item[0];
    expect(folder.name).toBe('Users');
    expect(folder.request).toBeUndefined();
    expect(folder.item).toHaveLength(1);
    expect(folder.item![0].name).toBe('List Users');
  });

  it('handles deeply nested groups', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeGroup('fld_1', 'wrk_1', 'Level1'),
      makeGroup('fld_2', 'fld_1', 'Level2'),
      makeRequest({ id: 'req_1', parentId: 'fld_2', name: 'Deep Request' }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    const l1 = collections[0].item[0];
    const l2 = l1.item![0];
    const req = l2.item![0];
    expect(l1.name).toBe('Level1');
    expect(l2.name).toBe('Level2');
    expect(req.name).toBe('Deep Request');
  });
});

// ─── parseInsomniaExport — headers ───────────────────────────────────────────

describe('parseInsomniaExport — headers', () => {
  it('maps enabled headers to CollectionHeader', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({
        headers: [
          { name: 'Authorization', value: 'Bearer {{token}}' },
          { name: 'X-Disabled', value: 'skip', disabled: true },
        ],
      }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    const headers = collections[0].item[0].request?.header ?? [];
    expect(headers).toHaveLength(1);
    expect(headers[0].key).toBe('Authorization');
    expect(headers[0].value).toBe('Bearer {{token}}');
  });

  it('omits header array when all headers are disabled', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ headers: [{ name: 'X-Disabled', value: 'skip', disabled: true }] }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    expect(collections[0].item[0].request?.header).toBeUndefined();
  });
});

// ─── parseInsomniaExport — query parameters ───────────────────────────────────

describe('parseInsomniaExport — query parameters', () => {
  it('maps enabled parameters to url.query', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({
        parameters: [
          { name: 'page', value: '1' },
          { name: 'hidden', value: 'x', disabled: true },
        ],
      }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    const url = collections[0].item[0].request?.url as { query?: Array<{ key: string; value: string }> };
    expect(url.query).toHaveLength(1);
    expect(url.query![0]).toEqual({ key: 'page', value: '1' });
  });

  it('omits url.query when all parameters are disabled', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ parameters: [{ name: 'hidden', value: 'x', disabled: true }] }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    const url = collections[0].item[0].request?.url as { query?: unknown };
    expect(url.query).toBeUndefined();
  });
});

// ─── parseInsomniaExport — auth ───────────────────────────────────────────────

describe('parseInsomniaExport — auth', () => {
  it('maps bearer auth', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ authentication: { type: 'bearer', token: 'mytoken' } }),
    ]);
    const auth = parseInsomniaExport(exp).collections[0].item[0].request?.auth;
    expect(auth?.type).toBe('bearer');
    expect(auth?.bearer?.[0]).toEqual({ key: 'token', value: 'mytoken' });
  });

  it('maps basic auth', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ authentication: { type: 'basic', username: 'admin', password: 'secret' } }),
    ]);
    const auth = parseInsomniaExport(exp).collections[0].item[0].request?.auth;
    expect(auth?.type).toBe('basic');
    const basicMap = Object.fromEntries((auth?.basic ?? []).map(e => [e.key, e.value]));
    expect(basicMap.username).toBe('admin');
    expect(basicMap.password).toBe('secret');
  });

  it('maps apikey auth with addTo header', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ authentication: { type: 'apikey', key: 'X-API-Key', value: 'abc', addTo: 'header' } }),
    ]);
    const auth = parseInsomniaExport(exp).collections[0].item[0].request?.auth;
    expect(auth?.type).toBe('apikey');
    const kv = Object.fromEntries((auth?.apikey ?? []).map(e => [e.key, e.value]));
    expect(kv.key).toBe('X-API-Key');
    expect(kv.value).toBe('abc');
    expect(kv.in).toBe('header');
  });

  it('maps apikey auth with addTo queryParams', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ authentication: { type: 'apikey', key: 'token', value: 'xyz', addTo: 'queryParams' } }),
    ]);
    const auth = parseInsomniaExport(exp).collections[0].item[0].request?.auth;
    const kv = Object.fromEntries((auth?.apikey ?? []).map(e => [e.key, e.value]));
    expect(kv.in).toBe('query');
  });

  it('sets type oauth2 for oauth2 auth', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ authentication: { type: 'oauth2' } }),
    ]);
    const auth = parseInsomniaExport(exp).collections[0].item[0].request?.auth;
    expect(auth?.type).toBe('oauth2');
  });

  it('omits auth on request when auth type is unrecognised (produces noauth, which is omitted)', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ authentication: { type: 'digest' } }),
    ]);
    // noauth is not added to the request auth field
    const auth = parseInsomniaExport(exp).collections[0].item[0].request?.auth;
    expect(auth).toBeUndefined();
  });

  it('omits auth when disabled is true', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ authentication: { type: 'bearer', token: 'tok', disabled: true } }),
    ]);
    const auth = parseInsomniaExport(exp).collections[0].item[0].request?.auth;
    expect(auth).toBeUndefined();
  });
});

// ─── parseInsomniaExport — body ───────────────────────────────────────────────

describe('parseInsomniaExport — body', () => {
  it('maps application/json body', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ body: { mimeType: 'application/json', text: '{"name":"Alice"}' } }),
    ]);
    const body = parseInsomniaExport(exp).collections[0].item[0].request?.body;
    expect(body?.mode).toBe('raw');
    expect(body?.raw).toBe('{"name":"Alice"}');
    expect(body?.options?.raw?.language).toBe('json');
  });

  it('maps text/plain body', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ body: { mimeType: 'text/plain', text: 'hello world' } }),
    ]);
    const body = parseInsomniaExport(exp).collections[0].item[0].request?.body;
    expect(body?.mode).toBe('raw');
    expect(body?.raw).toBe('hello world');
  });

  it('maps application/x-www-form-urlencoded body', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({
        body: {
          mimeType: 'application/x-www-form-urlencoded',
          params: [
            { name: 'user', value: 'alice' },
            { name: 'skip', value: 'x', disabled: true },
          ],
        },
      }),
    ]);
    const body = parseInsomniaExport(exp).collections[0].item[0].request?.body;
    expect(body?.mode).toBe('urlencoded');
    expect(body?.urlencoded).toHaveLength(1);
    expect(body?.urlencoded?.[0]).toEqual({ key: 'user', value: 'alice' });
  });

  it('maps multipart/form-data body', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({
        body: {
          mimeType: 'multipart/form-data',
          params: [{ name: 'file', value: 'data' }],
        },
      }),
    ]);
    const body = parseInsomniaExport(exp).collections[0].item[0].request?.body;
    expect(body?.mode).toBe('formdata');
    expect(body?.formdata?.[0]).toEqual({ key: 'file', value: 'data' });
  });

  it('maps application/graphql body', () => {
    const gqlBody = JSON.stringify({ query: '{ users { id } }', variables: { page: 1 } });
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ body: { mimeType: 'application/graphql', text: gqlBody } }),
    ]);
    const body = parseInsomniaExport(exp).collections[0].item[0].request?.body;
    expect(body?.mode).toBe('graphql');
    expect(body?.graphql?.query).toBe('{ users { id } }');
  });

  it('produces no body when body is undefined', () => {
    const exp = makeExport([makeWorkspace(), makeRequest({})]);
    const body = parseInsomniaExport(exp).collections[0].item[0].request?.body;
    expect(body).toBeUndefined();
  });
});

// ─── parseInsomniaExport — environments ──────────────────────────────────────

describe('parseInsomniaExport — environments', () => {
  it('maps environment data to AppEnvironment values', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeEnvironment('env_1', 'wrk_1', 'Production', { baseUrl: 'https://prod.example.com', apiKey: 'prod123' }),
    ]);
    const { environments } = parseInsomniaExport(exp);
    expect(environments).toHaveLength(1);
    expect(environments[0].name).toBe('Production');
    const kv = Object.fromEntries(environments[0].values.map(v => [v.key, v.value]));
    expect(kv.baseUrl).toBe('https://prod.example.com');
    expect(kv.apiKey).toBe('prod123');
    expect(environments[0].values.every(v => v.enabled)).toBe(true);
  });

  it('skips environments with no data', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeEnvironment('env_1', 'wrk_1', 'Empty'),
    ]);
    const { environments } = parseInsomniaExport(exp);
    expect(environments).toHaveLength(0);
  });

  it('skips environments with empty data object', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeEnvironment('env_1', 'wrk_1', 'Empty', {}),
    ]);
    const { environments } = parseInsomniaExport(exp);
    expect(environments).toHaveLength(0);
  });

  it('stringifies non-string values in environment data', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeEnvironment('env_1', 'wrk_1', 'Config', { timeout: 30, debug: true }),
    ]);
    const { environments } = parseInsomniaExport(exp);
    const kv = Object.fromEntries(environments[0].values.map(v => [v.key, v.value]));
    expect(kv.timeout).toBe('30');
    expect(kv.debug).toBe('true');
  });

  it('produces multiple environments from multiple environment resources', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeEnvironment('env_1', 'wrk_1', 'Staging', { url: 'https://staging.example.com' }),
      makeEnvironment('env_2', 'wrk_1', 'Production', { url: 'https://prod.example.com' }),
    ]);
    const { environments } = parseInsomniaExport(exp);
    expect(environments).toHaveLength(2);
    const names = environments.map(e => e.name);
    expect(names).toContain('Staging');
    expect(names).toContain('Production');
  });

  it('imports base environment (base_env_*) when it has data alongside named sub-environments', () => {
    // Insomnia always generates a base environment; named envs are children of it.
    // Apilix imports all of them as peers since it has no env hierarchy.
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeEnvironment('base_env_wrk_1', 'wrk_1', 'Base Environment', { sharedVar: 'shared' }),
      makeEnvironment('env_1', 'base_env_wrk_1', 'Staging', { url: 'https://staging.example.com' }),
      makeEnvironment('env_2', 'base_env_wrk_1', 'Production', { url: 'https://prod.example.com' }),
    ]);
    const { environments } = parseInsomniaExport(exp);
    // All three (base + 2 named) have data so all three appear as peers
    expect(environments).toHaveLength(3);
    const names = environments.map(e => e.name);
    expect(names).toContain('Base Environment');
    expect(names).toContain('Staging');
    expect(names).toContain('Production');
  });

  it('skips base environment when it has no data (common Insomnia default)', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      // base env with no data — Insomnia's default when user hasn't edited base vars
      makeEnvironment('base_env_wrk_1', 'wrk_1', 'Base Environment'),
      makeEnvironment('env_1', 'base_env_wrk_1', 'Staging', { url: 'https://staging.example.com' }),
    ]);
    const { environments } = parseInsomniaExport(exp);
    expect(environments).toHaveLength(1);
    expect(environments[0].name).toBe('Staging');
  });

  it('each environment value has enabled: true', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeEnvironment('env_1', 'wrk_1', 'Config', { a: '1', b: '2' }),
    ]);
    const { environments } = parseInsomniaExport(exp);
    expect(environments[0].values.every(v => v.enabled === true)).toBe(true);
  });

  it('each environment value has type "text"', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      makeEnvironment('env_1', 'wrk_1', 'Config', { x: 'y' }),
    ]);
    const { environments } = parseInsomniaExport(exp);
    expect(environments[0].values.every(v => v.type === 'text')).toBe(true);
  });
});

// ─── parseInsomniaExport — method normalisation ───────────────────────────────
// Normalise request methods to uppercase so imported requests are consistent  
// with the method format produced by the other Apilix importers. 

describe('parseInsomniaExport — method normalisation', () => {
  it('uppercases a lowercase method', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ method: 'get' }),
    ]);
    const method = parseInsomniaExport(exp).collections[0].item[0].request?.method;
    expect(method).toBe('GET');
  });

  it('uppercases a mixed-case method', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ method: 'Post' }),
    ]);
    const method = parseInsomniaExport(exp).collections[0].item[0].request?.method;
    expect(method).toBe('POST');
  });

  it('preserves an already-uppercase method', () => {
    const exp = makeExport([
      makeWorkspace(),
      makeRequest({ method: 'DELETE' }),
    ]);
    const method = parseInsomniaExport(exp).collections[0].item[0].request?.method;
    expect(method).toBe('DELETE');
  });

  it('defaults to GET when method is empty string', () => {
    const exp = makeExport([
      makeWorkspace(),
      // Force an empty method to exercise the fallback
      { ...makeRequest({}), method: '' },
    ]);
    const method = parseInsomniaExport(exp).collections[0].item[0].request?.method;
    expect(method).toBe('GET');
  });
});

// ─── parseInsomniaExport — cycle detection ────────────────────────────────────
// Review finding: circular parentId references in user-controlled input would
// previously cause an infinite recursion / stack overflow.  The visited-set fix
// must break the cycle and return an empty item array instead.

describe('parseInsomniaExport — cycle detection', () => {
  it('does not throw on a direct self-referencing group (A → parent A)', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      // group whose parentId points to itself
      { _id: 'fld_self', _type: 'request_group', parentId: 'fld_self', name: 'Self Loop' },
    ]);
    expect(() => parseInsomniaExport(exp)).not.toThrow();
  });

  it('direct self-referencing group produces no items under its workspace', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      { _id: 'fld_self', _type: 'request_group', parentId: 'fld_self', name: 'Self Loop' },
    ]);
    const { collections } = parseInsomniaExport(exp);
    // The self-referencing group is a child of itself, not of wrk_1, so
    // the workspace gets zero direct children.
    expect(collections[0].item).toHaveLength(0);
  });

  it('does not throw on a two-node cycle (A → B, B → A)', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      // fld_a is a child of wrk_1; fld_b is a child of fld_a;
      // fld_a is also registered as a child of fld_b (the cycle)
      { _id: 'fld_a', _type: 'request_group', parentId: 'wrk_1', name: 'Folder A' },
      { _id: 'fld_b', _type: 'request_group', parentId: 'fld_a', name: 'Folder B' },
      // extra entry that creates a back-edge: fld_a also claims fld_b as parent
      { _id: 'fld_a_back', _type: 'request_group', parentId: 'fld_b', name: 'Folder A (back)' },
    ]);
    expect(() => parseInsomniaExport(exp)).not.toThrow();
  });

  it('two-node cycle: reachable requests are still included up to the cycle boundary', () => {
    const exp = makeExport([
      makeWorkspace('wrk_1'),
      { _id: 'fld_a', _type: 'request_group', parentId: 'wrk_1', name: 'Folder A' },
      { _id: 'fld_b', _type: 'request_group', parentId: 'fld_a', name: 'Folder B' },
      // back-edge folder inside fld_b that points back up to fld_a
      { _id: 'fld_back', _type: 'request_group', parentId: 'fld_b', name: 'Back' },
      makeRequest({ id: 'req_good', parentId: 'fld_a', name: 'Good Request' }),
    ]);
    const { collections } = parseInsomniaExport(exp);
    // wrk_1 → fld_a (has Good Request + fld_b subtree)
    expect(collections[0].item).toHaveLength(1);
    const folderA = collections[0].item[0];
    expect(folderA.name).toBe('Folder A');
    // Good Request and fld_b are both direct children of fld_a
    expect(folderA.item!.some(i => i.name === 'Good Request')).toBe(true);
  });
});

// ─── Insomnia v5 YAML fixtures ────────────────────────────────────────────────

const V5_YAML_MINIMAL = `
type: collection.insomnia.rest/5.0
schema_version: "5.1"
name: My Collection
meta:
  id: wrk_abc
  description: ""
collection: []
`.trim();

const V5_YAML_WITH_REQUESTS = `
type: collection.insomnia.rest/5.0
schema_version: "5.1"
name: My Collection
meta:
  id: wrk_1
  description: ""
collection:
  - url: ""
    name: New Request
    meta:
      id: req_1
      description: ""
    method: GET
    headers:
      - name: User-Agent
        value: insomnia/12.5.0
        disabled: false
  - url: https://www.google.fr
    name: New Request 2
    meta:
      id: req_2
      description: Ceci est une doc
    method: GET
    headers:
      - name: X-Skip
        value: skip
        disabled: true
  - url: https://httpbin.org/get
    name: New Request 3
    meta:
      id: req_3
      description: ""
    method: GET
    parameters:
      - name: test1
        value: "&"
        disabled: false
      - name: test2
        value: "  3@"
        disabled: false
`.trim();

const V5_YAML_WITH_ENV = `
type: collection.insomnia.rest/5.0
schema_version: "5.1"
name: My Collection
meta:
  id: wrk_1
collection: []
environments:
  name: Base Environment
  meta:
    id: env_1
  data:
    baseUrl: https://api.example.com
    apiKey: secret123
`.trim();

// ─── parseInsomniaV5Export ────────────────────────────────────────────────────

describe('parseInsomniaV5Export', () => {
  it('produces one empty collection for a minimal export with no requests', () => {
    const { collections, environments } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'Empty',
      meta: { id: 'wrk_1' },
      collection: [],
    });
    expect(collections).toHaveLength(1);
    expect(collections[0].info.name).toBe('Empty');
    expect(collections[0].item).toHaveLength(0);
    expect(environments).toHaveLength(0);
  });

  it('maps collection name to info.name', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'Acme API',
      meta: { id: 'wrk_1' },
      collection: [],
    });
    expect(collections[0].info.name).toBe('Acme API');
  });

  it('assigns the Postman v2.1 schema string', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'Test',
      meta: { id: 'wrk_1' },
      collection: [],
    });
    expect(collections[0].info.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    );
  });

  it('uppercases a lowercase method', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [{ url: '', name: 'R', meta: { id: 'req_1' }, method: 'post' }],
    });
    expect(collections[0].item[0].request?.method).toBe('POST');
  });

  it('defaults to GET when method is empty string', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [{ url: '', name: 'R', meta: { id: 'req_1' }, method: '' }],
    });
    expect(collections[0].item[0].request?.method).toBe('GET');
  });

  it('maps enabled headers to CollectionHeader', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [{
        url: '',
        name: 'R',
        meta: { id: 'req_1' },
        method: 'GET',
        headers: [
          { name: 'Accept', value: 'application/json', disabled: false },
          { name: 'X-Skip', value: 'nope', disabled: true },
        ],
      }],
    });
    const headers = collections[0].item[0].request?.header ?? [];
    expect(headers).toHaveLength(1);
    expect(headers[0].key).toBe('Accept');
    expect(headers[0].value).toBe('application/json');
  });

  it('omits header when all headers are disabled', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [{
        url: 'https://example.com',
        name: 'R',
        meta: { id: 'req_1' },
        method: 'GET',
        headers: [{ name: 'X-Skip', value: 'nope', disabled: true }],
      }],
    });
    expect(collections[0].item[0].request?.header).toBeUndefined();
  });

  it('produces CollectionUrl with query when parameters are present', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [{
        url: 'https://httpbin.org/get',
        name: 'R',
        meta: { id: 'req_1' },
        method: 'GET',
        parameters: [
          { name: 'page', value: '1', disabled: false },
          { name: 'skip', value: 'x', disabled: true },
        ],
      }],
    });
    const url = collections[0].item[0].request?.url as { raw: string; query?: unknown[] };
    expect(typeof url).toBe('object');
    expect(url.raw).toBe('https://httpbin.org/get');
    expect(url.query).toHaveLength(1);
    expect((url.query![0] as { key: string }).key).toBe('page');
  });

  it('produces CollectionUrl with no query when all parameters are disabled', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [{
        url: 'https://example.com',
        name: 'R',
        meta: { id: 'req_1' },
        method: 'GET',
        parameters: [{ name: 'hidden', value: 'x', disabled: true }],
      }],
    });
    const url = collections[0].item[0].request?.url;
    expect(typeof url).toBe('object');
    expect((url as { raw: string }).raw).toBe('https://example.com');
    expect((url as { query?: unknown }).query).toBeUndefined();
  });

  it('does not include auth on a request with no authentication (noauth must not pollute)', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [{
        url: 'https://example.com',
        name: 'R',
        meta: { id: 'req_1' },
        method: 'GET',
      }],
    });
    expect(collections[0].item[0].request?.auth).toBeUndefined();
  });

  it('does not include auth when authentication is disabled', () => {
    const { collections } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [{
        url: 'https://example.com',
        name: 'R',
        meta: { id: 'req_1' },
        method: 'GET',
        authentication: { type: 'bearer', token: 'tok', disabled: true },
      }],
    });
    expect(collections[0].item[0].request?.auth).toBeUndefined();
  });

  it('maps environment data to AppEnvironment values', () => {
    const { environments } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [],
      environments: {
        name: 'Staging',
        meta: { id: 'env_1' },
        data: { baseUrl: 'https://staging.example.com', apiKey: 'key123' },
      },
    });
    expect(environments).toHaveLength(1);
    expect(environments[0].name).toBe('Staging');
    const kv = Object.fromEntries(environments[0].values.map(v => [v.key, v.value]));
    expect(kv.baseUrl).toBe('https://staging.example.com');
    expect(kv.apiKey).toBe('key123');
  });

  it('produces no environment when data is absent', () => {
    const { environments } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [],
    });
    expect(environments).toHaveLength(0);
  });

  it('produces no environment when data is empty', () => {
    const { environments } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [],
      environments: { name: 'Empty', meta: { id: 'env_1' }, data: {} },
    });
    expect(environments).toHaveLength(0);
  });

  it('stringifies non-string environment values', () => {
    const { environments } = parseInsomniaV5Export({
      type: 'collection.insomnia.rest/5.0',
      schema_version: '5.1',
      name: 'T',
      meta: { id: 'wrk_1' },
      collection: [],
      environments: {
        name: 'Config',
        meta: { id: 'env_1' },
        data: { timeout: 30, debug: true },
      },
    });
    const kv = Object.fromEntries(environments[0].values.map(v => [v.key, v.value]));
    expect(kv.timeout).toBe('30');
    expect(kv.debug).toBe('true');
  });
});

// ─── tryParseInsomniaText ─────────────────────────────────────────────────────

describe('tryParseInsomniaText', () => {
  it('returns null for empty string', () => {
    expect(tryParseInsomniaText('')).toBeNull();
  });

  it('returns null for plain prose text', () => {
    expect(tryParseInsomniaText('Hello, world!')).toBeNull();
  });

  it('returns null for Postman v2.1 JSON', () => {
    const postman = JSON.stringify({
      info: {
        name: 'My API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [],
    });
    expect(tryParseInsomniaText(postman)).toBeNull();
  });

  it('returns null for OpenAPI 3.0 YAML (must not misidentify)', () => {
    const openapi = `openapi: "3.0.0"\ninfo:\n  title: Test\n  version: "1.0"\npaths: {}`;
    expect(tryParseInsomniaText(openapi)).toBeNull();
  });

  it('returns parsed result for a valid v4 JSON export', () => {
    const exp = JSON.stringify({ __export_format: 4, resources: [] });
    const result = tryParseInsomniaText(exp);
    expect(result).not.toBeNull();
    expect(result!.collections).toHaveLength(0);
  });

  it('returns null for v4 JSON with wrong format (v3)', () => {
    const exp = JSON.stringify({ __export_format: 3, resources: [] });
    expect(tryParseInsomniaText(exp)).toBeNull();
  });

  it('returns parsed result for a valid v5 YAML export with 3 requests', () => {
    const result = tryParseInsomniaText(V5_YAML_WITH_REQUESTS);
    expect(result).not.toBeNull();
    expect(result!.collections).toHaveLength(1);
    expect(result!.collections[0].item).toHaveLength(3);
  });

  it('returns parsed result for v5 YAML with environment data', () => {
    const result = tryParseInsomniaText(V5_YAML_WITH_ENV);
    expect(result).not.toBeNull();
    expect(result!.environments).toHaveLength(1);
    expect(result!.environments[0].name).toBe('Base Environment');
    const kv = Object.fromEntries(result!.environments[0].values.map(v => [v.key, v.value]));
    expect(kv.baseUrl).toBe('https://api.example.com');
    expect(kv.apiKey).toBe('secret123');
  });
});
