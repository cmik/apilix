import { vi, describe, it, expect } from 'vitest';

let mockGenerateIdCounter = 0;

vi.mock('../store', () => ({
  generateId: () => `mock-id-${++mockGenerateIdCounter}`,
}));

import { parseHurlFile, generateHurlEntry } from './hurlUtils';

// ─── parseHurlFile ────────────────────────────────────────────────────────────

describe('parseHurlFile — single GET entry', () => {
  it('parses a minimal GET request', () => {
    const hurl = `GET https://api.example.com/users\n\nHTTP 200`;
    const items = parseHurlFile(hurl);
    expect(items).toHaveLength(1);
    expect(items[0].request?.method).toBe('GET');
    const url = items[0].request?.url;
    const rawUrl = typeof url === 'string' ? url : (url as any)?.raw ?? url;
    expect(rawUrl).toBe('https://api.example.com/users');
  });

  it('sets item name from method and path', () => {
    const hurl = `GET https://api.example.com/users\n\nHTTP *`;
    const items = parseHurlFile(hurl);
    expect(items[0].name).toBeTruthy();
  });
});

describe('parseHurlFile — headers', () => {
  it('captures request headers', () => {
    const hurl = `GET https://api.example.com\nAccept: application/json\n\nHTTP *`;
    const items = parseHurlFile(hurl);
    const headers = items[0].request?.header ?? [];
    expect(headers.some(h => h.key === 'Accept' && h.value === 'application/json')).toBe(true);
  });
});

describe('parseHurlFile — POST with JSON body', () => {
  it('parses body as raw mode', () => {
    const hurl = [
      'POST https://api.example.com/items',
      'Content-Type: application/json',
      '',
      '{"name": "thing"}',
      '',
      'HTTP *',
    ].join('\n');
    const items = parseHurlFile(hurl);
    expect(items[0].request?.body?.mode).toBe('raw');
    expect(items[0].request?.body?.raw).toContain('"name"');
  });
});

describe('parseHurlFile — multiple entries', () => {
  it('returns one item per HURL entry', () => {
    const hurl = [
      'GET https://api.example.com/a',
      '',
      'HTTP *',
      '',
      'POST https://api.example.com/b',
      '',
      'HTTP *',
      '',
      'DELETE https://api.example.com/c/1',
      '',
      'HTTP *',
    ].join('\n');
    const items = parseHurlFile(hurl);
    expect(items).toHaveLength(3);
    expect(items[0].request?.method).toBe('GET');
    expect(items[1].request?.method).toBe('POST');
    expect(items[2].request?.method).toBe('DELETE');
  });
});

describe('parseHurlFile — asserts', () => {
  it('generates a test event when asserts are present', () => {
    const hurl = [
      'GET https://api.example.com',
      '',
      'HTTP *',
      '[Asserts]',
      'status == 200',
    ].join('\n');
    const items = parseHurlFile(hurl);
    const events = items[0].event ?? [];
    const testEvent = events.find(e => e.listen === 'test');
    expect(testEvent).toBeDefined();
  });
});

describe('parseHurlFile — empty input', () => {
  it('returns empty array for empty string', () => {
    expect(parseHurlFile('')).toHaveLength(0);
  });

  it('returns empty array for comment-only content', () => {
    expect(parseHurlFile('# just a comment\n# another comment')).toHaveLength(0);
  });
});

// ─── generateHurlEntry ────────────────────────────────────────────────────────

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

describe('generateHurlEntry — request line', () => {
  it('opens with METHOD URL', () => {
    const output = generateHurlEntry(baseParams());
    expect(output.startsWith('GET https://api.example.com')).toBe(true);
  });

  it('ends with blank line and HTTP *', () => {
    const output = generateHurlEntry(baseParams());
    expect(output.trimEnd().endsWith('HTTP *')).toBe(true);
    const lines = output.split('\n');
    const httpIdx = lines.findIndex(l => l.trim().startsWith('HTTP'));
    expect(lines[httpIdx - 1].trim()).toBe('');
  });
});

describe('generateHurlEntry — auth', () => {
  it('emits bearer Authorization header', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      authType: 'bearer',
      authBearer: 'my-token',
    });
    expect(output).toContain('Authorization: Bearer my-token');
  });

  it('emits basic Authorization header (base64 encoded)', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      authType: 'basic',
      authBasicUser: 'user',
      authBasicPass: 'pass',
    });
    expect(output).toContain('Authorization: Basic ');
    // btoa('user:pass')
    expect(output).toContain(btoa('user:pass'));
  });

  it('emits api key as named header', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      authType: 'apikey',
      authApiKeyName: 'X-API-Key',
      authApiKeyValue: 'secret',
    });
    expect(output).toContain('X-API-Key: secret');
  });

  it('emits no auth header when authType is noauth', () => {
    const output = generateHurlEntry(baseParams());
    expect(output).not.toContain('Authorization:');
  });
});

describe('generateHurlEntry — headers', () => {
  it('includes enabled headers', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      headers: [{ key: 'X-Custom', value: 'val' }],
    });
    expect(output).toContain('X-Custom: val');
  });

  it('skips disabled headers', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      headers: [{ key: 'X-Skip', value: 'val', disabled: true }],
    });
    expect(output).not.toContain('X-Skip');
  });
});

describe('generateHurlEntry — body modes', () => {
  it('includes raw body after blank line', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'raw',
      bodyRaw: '{"key":"value"}',
    });
    const lines = output.split('\n');
    const bodyIdx = lines.findIndex(l => l.includes('"key"'));
    expect(bodyIdx).toBeGreaterThan(0);
    expect(lines[bodyIdx - 1].trim()).toBe('');
  });

  it('emits [FormParams] for urlencoded body', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'urlencoded',
      bodyUrlEncoded: [{ key: 'user', value: 'alice' }],
    });
    expect(output).toContain('[FormParams]');
    expect(output).toContain('user: alice');
  });

  it('emits [MultipartFormData] for formdata body', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'formdata',
      bodyFormData: [{ key: 'file', value: 'data' }],
    });
    expect(output).toContain('[MultipartFormData]');
  });

  it('emits graphql fenced block for graphql body', () => {
    const output = generateHurlEntry({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'graphql',
      bodyGraphqlQuery: '{ users { id } }',
    });
    expect(output).toContain('```graphql');
    expect(output).toContain('{ users { id } }');
    expect(output).toContain('```');
  });
});
