import { vi, describe, it, expect } from 'vitest';

let mockGenerateIdCounter = 0;

vi.mock('../store', () => ({
  generateId: () => `mock-id-${++mockGenerateIdCounter}`,
}));

import { parseHarFile } from './harUtils';

// ─── Error handling ────────────────────────────────────────────────────────────

describe('parseHarFile — invalid input', () => {
  it('throws on invalid JSON', () => {
    expect(() => parseHarFile('not json')).toThrow(/Invalid JSON/i);
  });

  it('throws when log.entries is missing', () => {
    expect(() => parseHarFile('{"log":{}}')).toThrow(/missing/i);
  });

  it('throws when log object is absent', () => {
    expect(() => parseHarFile('{}')).toThrow();
  });
});

// ─── Empty entries ────────────────────────────────────────────────────────────

describe('parseHarFile — empty entries', () => {
  it('returns empty array for zero entries', () => {
    const har = JSON.stringify({ log: { entries: [] } });
    expect(parseHarFile(har)).toHaveLength(0);
  });
});

// ─── GET request ──────────────────────────────────────────────────────────────

describe('parseHarFile — GET request', () => {
  function makeGetHar(url = 'https://api.example.com/users') {
    return JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'GET',
              url,
              headers: [
                { name: 'Accept', value: 'application/json' },
              ],
            },
          },
        ],
      },
    });
  }

  it('maps method correctly', () => {
    const items = parseHarFile(makeGetHar());
    expect(items[0].request?.method).toBe('GET');
  });

  it('maps url correctly', () => {
    const items = parseHarFile(makeGetHar());
    const url = items[0].request?.url;
    const raw = typeof url === 'string' ? url : (url as any)?.raw ?? url;
    expect(raw).toBe('https://api.example.com/users');
  });

  it('includes Accept header', () => {
    const items = parseHarFile(makeGetHar());
    const headers = items[0].request?.header ?? [];
    expect(headers.some(h => h.key === 'Accept')).toBe(true);
  });

  it('sets a non-empty item name', () => {
    const items = parseHarFile(makeGetHar());
    expect(items[0].name).toBeTruthy();
  });
});

// ─── Entry comment as name ────────────────────────────────────────────────────

describe('parseHarFile — entry comment as name', () => {
  function makeEntry(url: string, comment?: string) {
    const entry: Record<string, unknown> = {
      request: { method: 'GET', url },
    };
    if (comment !== undefined) entry.comment = comment;
    return entry;
  }

  it('uses comment as name when non-empty', () => {
    const har = JSON.stringify({ log: { entries: [makeEntry('https://api.example.com/users', 'My Request')] } });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('My Request');
  });

  it('falls back to URL-derived name when comment is empty string', () => {
    const har = JSON.stringify({ log: { entries: [makeEntry('https://api.example.com/users', '')] } });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET /users');
  });

  it('falls back to URL-derived name when comment is whitespace only', () => {
    const har = JSON.stringify({ log: { entries: [makeEntry('https://api.example.com/users', '   ')] } });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET /users');
  });

  it('falls back to URL-derived name when comment is absent', () => {
    const har = JSON.stringify({ log: { entries: [makeEntry('https://api.example.com/users')] } });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET /users');
  });

  it('preserves distinct comments per entry in a multi-entry HAR', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          makeEntry('https://api.example.com/users', 'List Users'),
          makeEntry('https://api.example.com/posts', 'List Posts'),
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('List Users');
    expect(items[1].name).toBe('List Posts');
  });
});

// ─── Pseudo-headers filtering ─────────────────────────────────────────────────

describe('parseHarFile — pseudo-header filtering', () => {
  it('drops :method pseudo-header', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'GET',
              url: 'https://api.example.com',
              headers: [
                { name: ':method', value: 'GET' },
                { name: ':path', value: '/users' },
                { name: 'X-Custom', value: 'kept' },
              ],
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    const headers = items[0].request?.header ?? [];
    expect(headers.some(h => h.key.startsWith(':'))).toBe(false);
    expect(headers.some(h => h.key === 'X-Custom')).toBe(true);
  });

  it('drops cookie header', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'GET',
              url: 'https://api.example.com',
              headers: [{ name: 'cookie', value: 'session=abc' }],
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    const headers = items[0].request?.header ?? [];
    expect(headers.some(h => h.key?.toLowerCase() === 'cookie')).toBe(false);
  });
});

// ─── POST with JSON body ──────────────────────────────────────────────────────

describe('parseHarFile — POST application/json', () => {
  it('sets bodyMode raw and language json', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/items',
              headers: [{ name: 'Content-Type', value: 'application/json' }],
              postData: { mimeType: 'application/json', text: '{"key":"val"}' },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].request?.body?.mode).toBe('raw');
    expect(items[0].request?.body?.options?.raw?.language).toBe('json');
    expect(items[0].request?.body?.raw).toContain('"key"');
  });
});

// ─── URL-encoded body ─────────────────────────────────────────────────────────

describe('parseHarFile — urlencoded body via params', () => {
  it('sets bodyMode urlencoded and maps params', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/form',
              headers: [],
              postData: {
                mimeType: 'application/x-www-form-urlencoded',
                params: [{ name: 'username', value: 'alice' }],
              },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].request?.body?.mode).toBe('urlencoded');
    const urlencoded = items[0].request?.body?.urlencoded ?? [];
    expect(urlencoded.some(p => p.key === 'username' && p.value === 'alice')).toBe(true);
  });

  it('parses urlencoded body from text when params array is empty', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/form',
              headers: [],
              postData: {
                mimeType: 'application/x-www-form-urlencoded',
                params: [],
                text: 'user=bob&role=admin',
              },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    const urlencoded = items[0].request?.body?.urlencoded ?? [];
    expect(urlencoded.some(p => p.key === 'user' && p.value === 'bob')).toBe(true);
    expect(urlencoded.some(p => p.key === 'role' && p.value === 'admin')).toBe(true);
  });
});

// ─── Multipart body ───────────────────────────────────────────────────────────

describe('parseHarFile — multipart body', () => {
  it('sets bodyMode formdata', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://api.example.com/upload',
              headers: [],
              postData: {
                mimeType: 'multipart/form-data',
                params: [{ name: 'file', value: 'data' }],
              },
            },
          },
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].request?.body?.mode).toBe('formdata');
  });
});

// ─── Entry comment as name ────────────────────────────────────────────────────

describe('parseHarFile — entry comment as name', () => {
  function makeEntry(url: string, comment?: string) {
    return { request: { method: 'GET', url, headers: [] }, ...(comment !== undefined ? { comment } : {}) };
  }

  it('uses comment as item name when non-empty', () => {
    const har = JSON.stringify({ log: { entries: [makeEntry('https://api.example.com/users', 'My Request')] } });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('My Request');
  });

  it('falls back to URL-derived name when comment is empty string', () => {
    const har = JSON.stringify({ log: { entries: [makeEntry('https://api.example.com/users', '')] } });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET /users');
  });

  it('falls back to URL-derived name when comment is whitespace-only', () => {
    const har = JSON.stringify({ log: { entries: [makeEntry('https://api.example.com/users', '   ')] } });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET /users');
  });

  it('falls back to URL-derived name when comment field is absent', () => {
    const har = JSON.stringify({ log: { entries: [makeEntry('https://api.example.com/users')] } });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('GET /users');
  });

  it('uses distinct comment per entry in multi-entry HAR', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          makeEntry('https://api.example.com/a', 'First'),
          makeEntry('https://api.example.com/b', 'Second'),
        ],
      },
    });
    const items = parseHarFile(har);
    expect(items[0].name).toBe('First');
    expect(items[1].name).toBe('Second');
  });
});

// ─── HAR export — comment field ───────────────────────────────────────────────

import { generateHarFromItems } from './harUtils';

describe('generateHarFromItems — entry comment field', () => {
  it('sets comment to item name on each entry', () => {
    const items = [
      {
        id: 'mock-id-x',
        name: 'Get Users',
        request: { method: 'GET', url: { raw: 'https://api.example.com/users' }, header: [] },
      },
    ];
    const raw = JSON.parse(generateHarFromItems(items));
    expect(raw.log.entries[0].comment).toBe('Get Users');
  });

  it('sets distinct comment per entry when multiple items', () => {
    const items = [
      { id: 'a', name: 'Alpha', request: { method: 'GET', url: { raw: 'https://example.com/a' }, header: [] } },
      { id: 'b', name: 'Beta', request: { method: 'POST', url: { raw: 'https://example.com/b' }, header: [] } },
    ];
    const raw = JSON.parse(generateHarFromItems(items));
    expect(raw.log.entries[0].comment).toBe('Alpha');
    expect(raw.log.entries[1].comment).toBe('Beta');
  });
});

// ─── Multiple pages (folder grouping) ────────────────────────────────────────

describe('parseHarFile — multi-page grouping', () => {
  it('wraps entries into folders when multiple pages exist', () => {
    const har = JSON.stringify({
      log: {
        pages: [
          { id: 'page_1', title: 'Page One' },
          { id: 'page_2', title: 'Page Two' },
        ],
        entries: [
          { pageref: 'page_1', request: { method: 'GET', url: 'https://a.com/1', headers: [] } },
          { pageref: 'page_2', request: { method: 'GET', url: 'https://b.com/2', headers: [] } },
        ],
      },
    });
    const items = parseHarFile(har);
    // With multiple pages, items should be grouped into folders
    const hasFolder = items.some(i => Array.isArray(i.item));
    expect(hasFolder).toBe(true);
  });
});
