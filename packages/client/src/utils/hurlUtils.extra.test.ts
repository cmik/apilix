import { vi, describe, it, expect } from 'vitest';

let mockIdCounter = 0;

vi.mock('../store', () => ({
  generateId: () => `mock-id-${++mockIdCounter}`,
}));

import { parseHurlFile, generateHurlEntry, generateHurlFromItems } from './hurlUtils';
import type { CollectionItem } from '../types';

// ─── generateHurlEntry — body modes ──────────────────────────────────────────

function baseParams() {
  return {
    method: 'GET',
    url: 'https://api.example.com',
    headers: [],
    bodyMode: 'none',
    bodyRaw: '',
    bodyFormData: [],
    bodyUrlEncoded: [],
    bodyGraphqlQuery: '',
    bodyGraphqlVariables: '',
    authType: 'noauth',
    authBearer: '',
    authBasicUser: '',
    authBasicPass: '',
    authApiKeyName: '',
    authApiKeyValue: '',
  };
}

describe('generateHurlEntry — apikey auth header', () => {
  it('emits apikey as custom header', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      authType: 'apikey',
      authApiKeyName: 'X-API-Key',
      authApiKeyValue: 'secret',
    });
    expect(output).toContain('X-API-Key: secret');
  });
});

describe('generateHurlEntry — urlencoded body', () => {
  it('emits [FormParams] section', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'urlencoded',
      bodyUrlEncoded: [
        { key: 'username', value: 'alice' },
        { key: 'password', value: 'secret' },
      ],
    });
    expect(output).toContain('[FormParams]');
    expect(output).toContain('username: alice');
    expect(output).toContain('password: secret');
  });

  it('skips disabled urlencoded params', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'urlencoded',
      bodyUrlEncoded: [
        { key: 'active', value: 'yes' },
        { key: 'inactive', value: 'no', disabled: true },
      ],
    });
    expect(output).toContain('active: yes');
    expect(output).not.toContain('inactive: no');
  });

  it('skips urlencoded params with empty key (section header still emitted)', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'urlencoded',
      bodyUrlEncoded: [{ key: '', value: 'orphan' }],
    });
    // Section header is emitted but the empty-key param line is not
    const lines = output.split('\n');
    expect(lines.some(l => l.includes(': orphan'))).toBe(false);
  });
});

describe('generateHurlEntry — formdata body', () => {
  it('emits [MultipartFormData] section', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'formdata',
      bodyFormData: [
        { key: 'file', value: 'data.csv' },
        { key: 'type', value: 'text/csv' },
      ],
    });
    expect(output).toContain('[MultipartFormData]');
    expect(output).toContain('file: data.csv');
    expect(output).toContain('type: text/csv');
  });

  it('skips disabled formdata fields', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'formdata',
      bodyFormData: [
        { key: 'active', value: 'yes' },
        { key: 'inactive', value: 'no', disabled: true },
      ],
    });
    expect(output).toContain('active: yes');
    expect(output).not.toContain('inactive');
  });

  it('skips formdata fields with empty key (section header still emitted)', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'formdata',
      bodyFormData: [{ key: '', value: 'ignored' }],
    });
    // Section header is emitted but the empty-key field line is not
    const lines = output.split('\n');
    expect(lines.some(l => l.includes(': ignored'))).toBe(false);
  });
});

describe('generateHurlEntry — graphql body', () => {
  it('emits graphql fence block', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'graphql',
      bodyGraphqlQuery: '{ users { id } }',
      bodyGraphqlVariables: '',
    });
    expect(output).toContain('```graphql');
    expect(output).toContain('{ users { id } }');
    expect(output).toContain('```');
  });

  it('includes variables block when provided', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'graphql',
      bodyGraphqlQuery: '{ users { id } }',
      bodyGraphqlVariables: '{"limit":10}',
    });
    expect(output).toContain('variables {');
    expect(output).toContain('{"limit":10}');
  });

  it('does not emit graphql block when query is empty', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'graphql',
      bodyGraphqlQuery: '',
      bodyGraphqlVariables: '',
    });
    expect(output).not.toContain('```graphql');
  });
});

describe('generateHurlEntry — disabled headers', () => {
  it('skips disabled headers', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      headers: [
        { key: 'X-Active', value: 'yes' },
        { key: 'X-Disabled', value: 'no', disabled: true },
      ],
    });
    expect(output).toContain('X-Active: yes');
    expect(output).not.toContain('X-Disabled');
  });

  it('skips headers with empty key', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      headers: [{ key: '', value: 'orphan' }],
    });
    // Should not contain orphan value as a standalone header line
    const lines = output.split('\n').slice(1); // skip the request line
    expect(lines.every(l => !l.includes(': orphan'))).toBe(true);
  });
});

// ─── generateHurlFromItems ────────────────────────────────────────────────────

describe('generateHurlFromItems — basic output', () => {
  it('generates entries for request items', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Get Users',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com/users' },
          header: [],
        },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('GET https://api.example.com/users');
    expect(output).toContain('HTTP');
  });

  it('joins multiple entries with double newline separator', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'GET /a',
        request: { method: 'GET', url: { raw: 'https://example.com/a' }, header: [] },
      },
      {
        id: 'r2',
        name: 'GET /b',
        request: { method: 'GET', url: { raw: 'https://example.com/b' }, header: [] },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('\n\n');
    expect(output).toContain('https://example.com/a');
    expect(output).toContain('https://example.com/b');
  });

  it('includes a comment for items whose name differs from METHOD URL', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'My Custom Name',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com/users' },
          header: [],
        },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('# My Custom Name');
  });

  it('does not include a comment when name equals METHOD URL', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'GET https://api.example.com/users',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com/users' },
          header: [] as any,
        },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).not.toContain('# GET https://api.example.com/users');
  });
});

describe('generateHurlFromItems — recursive folder traversal', () => {
  it('traverses nested folders to collect request items', () => {
    const items: CollectionItem[] = [
      {
        id: 'f1',
        name: 'Folder',
        item: [
          {
            id: 'r1',
            name: 'Nested',
            request: {
              method: 'POST',
              url: { raw: 'https://api.example.com/nested' },
              header: [],
            },
          },
        ],
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('POST https://api.example.com/nested');
  });

  it('handles deeply nested folders', () => {
    const items: CollectionItem[] = [
      {
        id: 'f1',
        name: 'Outer',
        item: [
          {
            id: 'f2',
            name: 'Inner',
            item: [
              {
                id: 'r1',
                name: 'Deep Request',
                request: {
                  method: 'DELETE',
                  url: { raw: 'https://api.example.com/deep' },
                  header: [],
                },
              },
            ],
          },
        ],
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('DELETE https://api.example.com/deep');
  });
});

describe('generateHurlFromItems — body modes', () => {
  it('includes raw body content', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'POST JSON',
        request: {
          method: 'POST',
          url: { raw: 'https://api.example.com/data' },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: { mode: 'raw', raw: '{"key":"value"}', options: { raw: { language: 'json' } } },
        },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('{"key":"value"}');
  });

  it('includes [FormParams] for urlencoded body', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Form',
        request: {
          method: 'POST',
          url: { raw: 'https://api.example.com/form' },
          header: [],
          body: {
            mode: 'urlencoded',
            urlencoded: [{ key: 'name', value: 'alice' }],
          },
        },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('[FormParams]');
    expect(output).toContain('name: alice');
  });

  it('includes [MultipartFormData] for formdata body', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Upload',
        request: {
          method: 'POST',
          url: { raw: 'https://api.example.com/upload' },
          header: [],
          body: {
            mode: 'formdata',
            formdata: [{ key: 'file', value: 'data.csv' }],
          },
        },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('[MultipartFormData]');
    expect(output).toContain('file: data.csv');
  });

  it('includes graphql fence block', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'GQL',
        request: {
          method: 'POST',
          url: { raw: 'https://api.example.com/graphql' },
          header: [],
          body: {
            mode: 'graphql',
            graphql: { query: '{ users { id } }', variables: '{}' },
          },
        },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('```graphql');
    expect(output).toContain('{ users { id } }');
  });
});

describe('generateHurlFromItems — assert round-trip', () => {
  it('produces concrete HTTP status line when status assert exists in test event', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'R',
        request: { method: 'GET', url: { raw: 'https://api.example.com' }, header: [] },
        event: [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: [
                '(function () {',
                '  apx.test("status == 200", function() { apx.expect(apx.response.code).to.equal(200); });',
                '})();',
              ],
            },
          },
        ],
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('HTTP 200');
  });

  it('uses HTTP * when no status assert exists', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'R',
        request: { method: 'GET', url: { raw: 'https://api.example.com' }, header: [] },
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('HTTP *');
  });

  it('includes non-status assert lines in [Asserts] section', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'R',
        request: { method: 'GET', url: { raw: 'https://api.example.com' }, header: [] },
        event: [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: [
                '(function () {',
                '  apx.test("status == 200", function() { apx.expect(apx.response.code).to.equal(200); });',
                '  apx.test("body contains hello", function() { apx.expect(apx.response.text()).to.include("hello"); });',
                '})();',
              ],
            },
          },
        ],
      },
    ];
    const output = generateHurlFromItems(items);
    expect(output).toContain('[Asserts]');
  });
});

// ─── parseHurlFile — advanced parsing ────────────────────────────────────────

describe('parseHurlFile — [QueryStringParams] section', () => {
  it('appends query params to URL', () => {
    const hurl = [
      'GET https://api.example.com/search',
      '[QueryStringParams]',
      'q: hello world',
      'page: 2',
      '',
      'HTTP *',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const rawUrl = (items[0].request?.url as any)?.raw ?? items[0].request?.url;
    expect(rawUrl).toContain('q=hello%20world');
    expect(rawUrl).toContain('page=2');
  });
});

describe('parseHurlFile — [Query] section (short form)', () => {
  it('accepts [Query] as short form of [QueryStringParams]', () => {
    const hurl = [
      'GET https://api.example.com/search',
      '[Query]',
      'filter: active',
      '',
      'HTTP *',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const rawUrl = (items[0].request?.url as any)?.raw ?? items[0].request?.url;
    expect(rawUrl).toContain('filter=active');
  });
});

describe('parseHurlFile — HTTP response line status assertion', () => {
  it('generates an implicit status assert from HTTP/1.1 200 line', () => {
    const hurl = [
      'GET https://api.example.com/users',
      '',
      'HTTP/1.1 200',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const testEvent = items[0].event?.find(e => e.listen === 'test');
    expect(testEvent).toBeDefined();
    // The script should contain status == 200
    const execLines = testEvent?.script?.exec as string[];
    expect(execLines.join('\n')).toContain('status == 200');
  });
});

describe('parseHurlFile — [Captures] section', () => {
  it('generates a test event with capture code', () => {
    const hurl = [
      'GET https://api.example.com/auth',
      '',
      'HTTP *',
      '[Captures]',
      'token: jsonpath "$.token"',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const testEvent = items[0].event?.find(e => e.listen === 'test');
    expect(testEvent).toBeDefined();
    const script = (testEvent?.script?.exec as string[]).join('\n');
    expect(script).toContain('apx.environment.set');
    expect(script).toContain('"token"');
  });

  it('generates header capture', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Captures]',
      'sessionId: header "Set-Cookie"',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('apx.response.headers.get');
    expect(script).toContain('"Set-Cookie"');
  });
});

describe('parseHurlFile — [Asserts] with various predicates', () => {
  it('converts status == predicate to test', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'status == 200',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('apx.test');
    expect(script).toContain('equal(200)');
  });

  it('converts jsonpath contains predicate to test', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'jsonpath "$.name" contains "Alice"',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('include');
    expect(script).toContain('"Alice"');
  });

  it('converts body exists predicate to test', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'body exists',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('.to.exist');
  });

  it('converts >= predicate to least()', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'status >= 200',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('least(200)');
  });

  it('converts < predicate to below()', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'status < 300',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('below(300)');
  });

  it('converts != predicate to not.equal()', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'status != 404',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('not.equal');
  });

  it('converts not contains predicate with negation', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'body not contains "error"',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('.to.not.include');
  });

  it('emits a comment for unsupported assert types', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'version == HTTP/1.1',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const script = (items[0].event?.[0]?.script?.exec as string[]).join('\n');
    expect(script).toContain('// ');
  });
});

describe('parseHurlFile — graphql body (fence syntax)', () => {
  it('parses graphql fence as graphql body mode', () => {
    const hurl = [
      'POST https://api.example.com/graphql',
      'Content-Type: application/json',
      '',
      '```graphql',
      '{ users { id name } }',
      '```',
      '',
      'HTTP *',
    ].join('\n');
    const items = parseHurlFile(hurl);
    expect(items[0].request?.body?.mode).toBe('graphql');
    expect(items[0].request?.body?.graphql?.query).toBe('{ users { id name } }');
  });
});

describe('parseHurlFile — comment lines skipped', () => {
  it('skips comment lines in entry body', () => {
    const hurl = [
      'GET https://api.example.com',
      '# This is a comment',
      'Accept: application/json',
      '',
      'HTTP *',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const headers = items[0].request?.header ?? [];
    expect(headers.some(h => h.key === 'Accept')).toBe(true);
    // Comment line should not appear as a header
    expect(headers.some(h => h.key.startsWith('#'))).toBe(false);
  });
});

describe('parseHurlFile — URL with existing query string', () => {
  it('appends query params with & when URL already has ?', () => {
    const hurl = [
      'GET https://api.example.com/search?q=hello',
      '[QueryStringParams]',
      'page: 2',
      '',
      'HTTP *',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const rawUrl = (items[0].request?.url as any)?.raw ?? items[0].request?.url;
    expect(rawUrl).toContain('q=hello');
    expect(rawUrl).toContain('&page=2');
  });
});
