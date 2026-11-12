import { vi, describe, it, expect } from 'vitest';

// codeGen -> hurlUtils imports the store (which touches window); stub it like hurlUtils.test does.
vi.mock('../store', () => ({ generateId: () => 'mock-id' }));

import type { DocRequestModel } from '../types';
import { DOC_SNIPPET_LANGUAGES, docRequestToCodeGenParams } from './docsCodeGenAdapter';

function model(overrides: Partial<DocRequestModel> = {}): DocRequestModel {
  return {
    id: 'r1', name: 'x', method: 'POST', url: 'https://x.test/a', fullUrl: 'https://x.test/a?p=1', baseUrl: 'https://x.test', path: '/a',
    folderPath: [], description: '', headers: [{ key: 'X-A', value: '1' }], query: [{ key: 'p', value: '1' }], pathVariables: [],
    body: { mode: 'raw', language: 'json', raw: '{"a":1}' }, auth: null, examples: [], ...overrides,
  };
}

describe('docRequestToCodeGenParams', () => {
  it('maps basic fields and raw body', () => {
    const p = docRequestToCodeGenParams(model());
    expect(p.method).toBe('POST');
    expect(p.url).toBe('https://x.test/a?p=1');
    expect(p.bodyMode).toBe('raw');
    expect(p.bodyRaw).toBe('{"a":1}');
    expect(p.authType).toBe('noauth');
  });

  it('maps bearer with redacted value without leaking anything', () => {
    const p = docRequestToCodeGenParams(model({ auth: { type: 'bearer', source: 'collection', fields: [{ key: 'token', value: '<redacted>' }] } }));
    expect(p.authType).toBe('bearer');
    expect(p.authBearer).toBe('<redacted>');
  });

  it('uses a placeholder header for basic auth with redacted/variable credentials', () => {
    const p = docRequestToCodeGenParams(model({ auth: { type: 'basic', source: 'request', fields: [{ key: 'username', value: '{{u}}' }, { key: 'password', value: '<redacted>' }] } }));
    expect(p.authType).toBe('noauth');
    expect(p.headers[0]).toEqual({ key: 'Authorization', value: 'Basic <credentials>' });
  });

  it('puts query api keys into the url and header api keys into auth fields', () => {
    const q = docRequestToCodeGenParams(model({ auth: { type: 'apikey', source: 'request', in: 'query', name: 'k', fields: [{ key: 'value', value: '<redacted>' }] } }));
    expect(q.url).toBe('https://x.test/a?p=1&k=<redacted>');
    const h = docRequestToCodeGenParams(model({ auth: { type: 'apikey', source: 'request', in: 'header', name: 'X-Key', fields: [{ key: 'value', value: '<redacted>' }] } }));
    expect(h.authApiKeyName).toBe('X-Key');
  });

  it('maps urlencoded, formdata and graphql bodies', () => {
    expect(docRequestToCodeGenParams(model({ body: { mode: 'urlencoded', fields: [{ key: 'a', value: '1' }] } })).bodyUrlEncoded).toEqual([{ key: 'a', value: '1' }]);
    expect(docRequestToCodeGenParams(model({ body: { mode: 'formdata', fields: [{ key: 'f', value: 'v' }] } })).bodyFormData).toEqual([{ key: 'f', value: 'v' }]);
    const g = docRequestToCodeGenParams(model({ body: { mode: 'graphql', graphql: { query: '{ me }', variables: '{}' } } }));
    expect(g.bodyGraphqlQuery).toBe('{ me }');
  });
});

describe('DOC_SNIPPET_LANGUAGES', () => {
  it('includes curl and every registry language, and each generates output', () => {
    expect(DOC_SNIPPET_LANGUAGES[0].id).toBe('curl');
    expect(DOC_SNIPPET_LANGUAGES.length).toBeGreaterThan(5);
    for (const lang of DOC_SNIPPET_LANGUAGES) {
      expect(lang.generate(model()).length, lang.id).toBeGreaterThan(0);
    }
  });
});
