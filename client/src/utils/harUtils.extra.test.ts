import { vi, describe, it, expect } from 'vitest';

let mockIdCounter = 0;

vi.mock('../store', () => ({
  generateId: () => `mock-id-${++mockIdCounter}`,
}));

import { generateHarFromItems, parseHarFile } from './harUtils';
import type { CollectionItem } from '../types';

// ─── generateHarFromItems — body modes ───────────────────────────────────────

describe('generateHarFromItems — raw JSON body', () => {
  it('sets mimeType to application/json for json language', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Create User',
        request: {
          method: 'POST',
          url: { raw: 'https://api.example.com/users' },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: { mode: 'raw', raw: '{"name":"Alice"}', options: { raw: { language: 'json' } } },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    expect(har.log.entries[0].request.postData.mimeType).toBe('application/json');
    expect(har.log.entries[0].request.postData.text).toBe('{"name":"Alice"}');
  });

  it('sets mimeType to application/xml for xml language', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'XML',
        request: {
          method: 'POST',
          url: { raw: 'https://api.example.com/xml' },
          header: [],
          body: { mode: 'raw', raw: '<root/>', options: { raw: { language: 'xml' } } },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    expect(har.log.entries[0].request.postData.mimeType).toBe('application/xml');
  });

  it('sets mimeType to text/html for html language', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'HTML',
        request: {
          method: 'POST',
          url: { raw: 'https://api.example.com/html' },
          header: [],
          body: { mode: 'raw', raw: '<html/>', options: { raw: { language: 'html' } } },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    expect(har.log.entries[0].request.postData.mimeType).toBe('text/html');
  });

  it('sets mimeType to text/plain for text language', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Plain',
        request: {
          method: 'POST',
          url: { raw: 'https://api.example.com/txt' },
          header: [],
          body: { mode: 'raw', raw: 'hello world', options: { raw: { language: 'text' } } },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    expect(har.log.entries[0].request.postData.mimeType).toBe('text/plain');
  });
});

describe('generateHarFromItems — urlencoded body', () => {
  it('sets mimeType to application/x-www-form-urlencoded and includes params', () => {
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
            urlencoded: [
              { key: 'username', value: 'alice' },
              { key: 'password', value: 'secret' },
            ],
          },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const postData = har.log.entries[0].request.postData;
    expect(postData.mimeType).toBe('application/x-www-form-urlencoded');
    expect(postData.params).toContainEqual({ name: 'username', value: 'alice' });
    expect(postData.params).toContainEqual({ name: 'password', value: 'secret' });
  });

  it('excludes disabled urlencoded params', () => {
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
            urlencoded: [
              { key: 'active', value: 'yes' },
              { key: 'inactive', value: 'no', disabled: true },
            ],
          },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const params = har.log.entries[0].request.postData.params;
    expect(params.some((p: any) => p.name === 'active')).toBe(true);
    expect(params.some((p: any) => p.name === 'inactive')).toBe(false);
  });
});

describe('generateHarFromItems — formdata body', () => {
  it('sets mimeType to multipart/form-data', () => {
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
            formdata: [
              { key: 'file', value: 'data.csv' },
              { key: 'type', value: 'text/csv' },
            ],
          },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const postData = har.log.entries[0].request.postData;
    expect(postData.mimeType).toBe('multipart/form-data');
    expect(postData.params).toContainEqual({ name: 'file', value: 'data.csv' });
  });

  it('excludes disabled formdata params', () => {
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
            formdata: [
              { key: 'active', value: 'yes' },
              { key: 'hidden', value: 'no', disabled: true },
            ],
          },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const params = har.log.entries[0].request.postData.params;
    expect(params.some((p: any) => p.name === 'active')).toBe(true);
    expect(params.some((p: any) => p.name === 'hidden')).toBe(false);
  });
});

describe('generateHarFromItems — graphql body', () => {
  it('serializes graphql query as JSON body', () => {
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
            graphql: { query: '{ users { id name } }', variables: '{"limit":10}' },
          },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const postData = har.log.entries[0].request.postData;
    expect(postData.mimeType).toBe('application/json');
    const parsed = JSON.parse(postData.text);
    expect(parsed.query).toBe('{ users { id name } }');
    expect(parsed.variables).toEqual({ limit: 10 });
  });
});

describe('generateHarFromItems — auth injection', () => {
  it('injects bearer token as Authorization header', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Bearer',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com' },
          header: [],
          auth: {
            type: 'bearer',
            bearer: [{ key: 'token', value: 'my-token' }],
          },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const headers = har.log.entries[0].request.headers;
    expect(headers).toContainEqual({ name: 'Authorization', value: 'Bearer my-token' });
  });

  it('injects basic auth as Authorization header', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Basic',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com' },
          header: [],
          auth: {
            type: 'basic',
            basic: [
              { key: 'username', value: 'user' },
              { key: 'password', value: 'pass' },
            ],
          },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const headers = har.log.entries[0].request.headers;
    const authHeader = headers.find((h: any) => h.name === 'Authorization');
    expect(authHeader?.value).toMatch(/^Basic /);
  });

  it('injects apikey as header when addTo is header', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'ApiKey',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com' },
          header: [],
          auth: {
            type: 'apikey',
            apikey: [
              { key: 'key', value: 'X-API-Key' },
              { key: 'value', value: 'secret' },
              { key: 'in', value: 'header' },
            ],
          },
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const headers = har.log.entries[0].request.headers;
    expect(headers).toContainEqual({ name: 'X-API-Key', value: 'secret' });
  });
});

describe('generateHarFromItems — query string from URL object', () => {
  it('includes query params from url.query array', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Search',
        request: {
          method: 'GET',
          url: {
            raw: 'https://api.example.com/search?q=test',
            query: [
              { key: 'q', value: 'test' },
              { key: 'page', value: '2' },
            ],
          },
          header: [],
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const qs = har.log.entries[0].request.queryString;
    expect(qs).toContainEqual({ name: 'q', value: 'test' });
    expect(qs).toContainEqual({ name: 'page', value: '2' });
  });

  it('excludes disabled query params', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Search',
        request: {
          method: 'GET',
          url: {
            raw: 'https://api.example.com/search',
            query: [
              { key: 'active', value: 'yes' },
              { key: 'disabled', value: 'no', disabled: true },
            ],
          },
          header: [],
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const qs = har.log.entries[0].request.queryString;
    expect(qs.some((q: any) => q.name === 'active')).toBe(true);
    expect(qs.some((q: any) => q.name === 'disabled')).toBe(false);
  });
});

describe('generateHarFromItems — folder traversal', () => {
  it('recursively collects requests from nested folders', () => {
    const items: CollectionItem[] = [
      {
        id: 'f1',
        name: 'Folder',
        item: [
          {
            id: 'r1',
            name: 'Nested Request',
            request: {
              method: 'GET',
              url: { raw: 'https://api.example.com/nested' },
              header: [],
            },
          },
        ],
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].request.url).toBe('https://api.example.com/nested');
  });

  it('skips folder items that have no request', () => {
    const items: CollectionItem[] = [
      { id: 'f1', name: 'Empty Folder', item: [] },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    expect(har.log.entries).toHaveLength(0);
  });
});

describe('generateHarFromItems — disabled headers excluded', () => {
  it('does not include disabled request headers', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'R',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com' },
          header: [
            { key: 'X-Active', value: 'yes' },
            { key: 'X-Disabled', value: 'no', disabled: true },
          ],
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    const headers = har.log.entries[0].request.headers;
    expect(headers.some((h: any) => h.name === 'X-Active')).toBe(true);
    expect(headers.some((h: any) => h.name === 'X-Disabled')).toBe(false);
  });
});

describe('generateHarFromItems — HAR structure', () => {
  it('produces valid HAR 1.2 structure', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Test',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com' },
          header: [],
        },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('Apilix');
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.entries[0].pageref).toBe('page_1');
  });

  it('uses collectionName as page title', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Test',
        request: { method: 'GET', url: { raw: 'https://api.example.com' }, header: [] },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items, 'My Collection'));
    expect(har.log.pages[0].title).toBe('My Collection');
  });

  it('uses string url directly', () => {
    const items: CollectionItem[] = [
      {
        id: 'r1',
        name: 'Test',
        request: { method: 'GET', url: 'https://api.example.com/string', header: [] },
      },
    ];
    const har = JSON.parse(generateHarFromItems(items));
    expect(har.log.entries[0].request.url).toBe('https://api.example.com/string');
  });
});

// ─── parseHarFile — XML/HTML body ─────────────────────────────────────────────

describe('parseHarFile — XML body', () => {
  it('sets raw mode with xml language for application/xml', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/xml',
              headers: [],
              postData: { mimeType: 'application/xml', text: '<root/>' },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].request?.body?.mode).toBe('raw');
    expect((items[0].request?.body?.options?.raw as any)?.language).toBe('xml');
  });

  it('sets raw mode with xml language for text/xml', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/xml',
              headers: [],
              postData: { mimeType: 'text/xml', text: '<root/>' },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect((items[0].request?.body?.options?.raw as any)?.language).toBe('xml');
  });

  it('sets raw mode with html language for text/html', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/html',
              headers: [],
              postData: { mimeType: 'text/html', text: '<html/>' },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect((items[0].request?.body?.options?.raw as any)?.language).toBe('html');
  });

  it('sets raw mode with text language for unknown mimeType with text', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/other',
              headers: [],
              postData: { mimeType: 'application/octet-stream', text: 'some binary' },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].request?.body?.mode).toBe('raw');
    expect((items[0].request?.body?.options?.raw as any)?.language).toBe('text');
  });

  it('returns undefined body when postData has no mimeType match and no text', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/other',
              headers: [],
              postData: { mimeType: 'application/octet-stream', text: '' },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].request?.body).toBeUndefined();
  });
});

describe('parseHarFile — missing headers array', () => {
  it('handles request with no headers property', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: { method: 'GET', url: 'https://api.example.com' },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items).toHaveLength(1);
    expect(items[0].request?.header).toHaveLength(0);
  });
});

describe('parseHarFile — URL-derived name', () => {
  it('uses full path when multiple path segments exist', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          { request: { method: 'GET', url: 'https://api.example.com/v1/users/123' } },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET /v1/users/123');
  });

  it('uses / for root URL', () => {
    const har = JSON.stringify({
      log: {
        entries: [{ request: { method: 'GET', url: 'https://api.example.com/' } }],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET /');
  });

  it('falls back to raw URL when URL is unparseable', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          { request: { method: 'GET', url: 'not-a-valid-url' } },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET not-a-valid-url');
  });
});
