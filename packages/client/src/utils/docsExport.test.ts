import { vi, describe, it, expect } from 'vitest';

// codeGen -> hurlUtils imports the store (which touches window); stub it like hurlUtils.test does.
vi.mock('../store', () => ({ generateId: () => 'mock-id' }));

import { load as yamlLoad } from 'js-yaml';
import type { AppCollection, AppEnvironment } from '../types';
import { docsFilename, exportCollectionDocs, secretVariants, splitEnvironmentVars } from './docsExport';
import { parseOpenApiSpec } from './openApiUtils';
import { maskSecrets, buildSecretSet } from './secretMask';

function makeCollection(): AppCollection {
  return {
    _id: 'c1',
    info: { name: 'Shop API', description: 'Shop docs', schema: 'x' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 'LITERAL-TOKEN' }] },
    item: [
      {
        id: 'f1',
        name: 'Products',
        item: [
          {
            id: 'r1',
            name: 'List products',
            request: {
              method: 'GET',
              url: { raw: '{{baseUrl}}/products?limit=10&api_key=LITERAL-KEY' },
              header: [{ key: 'X-Trace', value: 'abc' }],
            },
            response: [{ name: 'OK', code: 200, status: 'OK', header: [{ key: 'Content-Type', value: 'application/json' }], body: '[{"id":1,"name":"Pen"}]' }],
          },
          {
            id: 'r2',
            name: 'Create product',
            request: {
              method: 'POST',
              url: '{{baseUrl}}/products',
              body: { mode: 'raw', raw: '{"name":"Pen","price":1.5}', options: { raw: { language: 'json' } } },
            },
          },
          {
            id: 'r3',
            name: 'Get product',
            request: { method: 'GET', url: { raw: '{{baseUrl}}/products/:id', variable: [{ key: 'id', value: '7' }] } },
          },
        ],
      },
    ],
  };
}

const env: AppEnvironment = {
  _id: 'e1',
  name: 'Prod',
  values: [
    { key: 'baseUrl', value: 'https://shop.example.com', enabled: true },
    { key: 'adminPass', value: 'ENV-SECRET-VALUE', enabled: true, secret: true },
    { key: 'off', value: 'x', enabled: false },
  ],
};

describe('splitEnvironmentVars', () => {
  it('separates secret keys and drops disabled rows', () => {
    const { variables, secretKeys } = splitEnvironmentVars(env);
    expect(variables).toEqual({ baseUrl: 'https://shop.example.com' });
    expect(secretKeys).toEqual(['adminPass']);
    expect(splitEnvironmentVars(null)).toEqual({ variables: {}, secretKeys: [] });
  });
});

describe('exportCollectionDocs', () => {
  it('generates html with snippets from the client registry', () => {
    const r = exportCollectionDocs(makeCollection(), { format: 'html', snippetLanguages: ['curl', 'python'] });
    expect(r.mimeType).toBe('text/html');
    expect(r.content).toContain('List products');
    expect(r.content).toContain('cURL');
    expect(r.content).toContain('import requests');
    expect(r.content).not.toContain('LITERAL-TOKEN');
    expect(r.content).not.toContain('LITERAL-KEY');
  });

  it('keeps {{var}} by default and resolves only non-secret values on request', () => {
    const keep = exportCollectionDocs(makeCollection(), { format: 'markdown' });
    expect(keep.content).toContain('{{baseUrl}}/products');
    const resolved = exportCollectionDocs(makeCollection(), { format: 'markdown', variableMode: 'resolve' }, { environment: env });
    expect(resolved.content).toContain('https://shop.example.com/products');
  });

  it('never substitutes secret environment values', () => {
    const col = makeCollection();
    col.item[0].item![1].request!.url = '{{baseUrl}}/p/{{adminPass}}';
    const r = exportCollectionDocs(col, { format: 'markdown', variableMode: 'resolve' }, { environment: env });
    expect(r.content).not.toContain('ENV-SECRET-VALUE');
    expect(r.content).toContain('{{adminPass}}');
  });

  it('applies a final secret mask pass even with includeCredentials', () => {
    const col = makeCollection();
    col.auth = { type: 'bearer', bearer: [{ key: 'token', value: 'ENV-SECRET-VALUE' }] };
    const secrets = buildSecretSet([env], 'e1');
    const r = exportCollectionDocs(col, { format: 'markdown', includeCredentials: true }, { environment: env, secretValues: secrets });
    expect(r.content).not.toContain('ENV-SECRET-VALUE');
    expect(maskSecrets('a ENV-SECRET-VALUE b', secrets)).not.toContain('ENV-SECRET-VALUE');
  });

  it('scopes to a folder by id', () => {
    const col = makeCollection();
    col.item.push({ id: 'f2', name: 'Orders', item: [{ id: 'r9', name: 'List orders', request: { method: 'GET', url: 'https://x.test/orders' } }] });
    const r = exportCollectionDocs(col, { format: 'markdown', folder: 'f2' });
    expect(r.content).toContain('List orders');
    expect(r.content).not.toContain('List products');
  });

  it('openapi output round-trips through parseOpenApiSpec (yaml and json)', () => {
    for (const openapiFormat of ['yaml', 'json'] as const) {
      const r = exportCollectionDocs(makeCollection(), { format: 'openapi', openapiFormat });
      const parsedDoc = yamlLoad(r.content) as { openapi: string; paths: Record<string, unknown> };
      expect(parsedDoc.openapi).toBe('3.0.3');
      expect(Object.keys(parsedDoc.paths)).toEqual(['/products', '/products/{id}']);
      const imported = parseOpenApiSpec(r.content, 'shop');
      expect(imported.collectionName).toBe('Shop API');
      const names: string[] = [];
      const walk = (items: typeof imported.items) => items.forEach(i => (i.item ? walk(i.item) : names.push(i.name)));
      walk(imported.items);
      expect(names.sort()).toEqual(['Create product', 'Get product', 'List products']);
      expect(imported.collectionAuth?.type).toBe('bearer');
    }
  });

  it('openapi 3.1 flag', () => {
    const r = exportCollectionDocs(makeCollection(), { format: 'openapi', openapiFormat: 'json', openapiVersion: '3.1.0' });
    expect(JSON.parse(r.content).openapi).toBe('3.1.0');
  });
});

describe('docsFilename', () => {
  it('sanitises the name and uses format-specific suffixes', () => {
    expect(docsFilename('My/API', { format: 'html', extension: 'html' })).toBe('My_API.docs.html');
    expect(docsFilename('API', { format: 'openapi', extension: 'yaml' })).toBe('API.openapi.yaml');
    expect(docsFilename('', { format: 'markdown', extension: 'md' })).toBe('collection.docs.md');
  });
});

describe('exportCollectionDocs escaped-form secret masking', () => {
  const tricky = 'pw&<tag>"q\'\\back|pipe\nline2';
  const trickyEnv: AppEnvironment = {
    _id: 'e2', name: 'T', values: [{ key: 'tricky', value: tricky, enabled: true, secret: true }],
  };

  it('masks HTML/JSON/YAML/markdown-escaped forms with includeCredentials on', () => {
    const col = makeCollection();
    col.item[0].item![1].request!.header = [{ key: 'X-Custom', value: tricky }];
    col.item[0].item![1].request!.body = { mode: 'raw', raw: JSON.stringify({ note: tricky }), options: { raw: { language: 'json' } } };
    col.item[0].item![1].request!.description = tricky;
    const secrets = buildSecretSet([trickyEnv], 'e2');
    const forms = [tricky, tricky.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'), JSON.stringify(tricky).slice(1, -1), 'pw&amp;&lt;tag&gt;'];
    const outputs = [
      exportCollectionDocs(col, { format: 'html', includeCredentials: true, snippetLanguages: ['curl'] }, { secretValues: secrets }),
      exportCollectionDocs(col, { format: 'markdown', includeCredentials: true, snippetLanguages: ['curl'] }, { secretValues: secrets }),
      exportCollectionDocs(col, { format: 'openapi', openapiFormat: 'json', includeCredentials: true }, { secretValues: secrets }),
      exportCollectionDocs(col, { format: 'openapi', openapiFormat: 'yaml', includeCredentials: true }, { secretValues: secrets }),
    ];
    for (const out of outputs) {
      for (const f of forms) expect(out.content, `${out.format}: ${f}`).not.toContain(f);
      expect(out.content).not.toContain('back|pipe');
      if (out.spec) expect(JSON.stringify(out.spec)).not.toContain('pipe');
    }
  });

  it('secretVariants covers the escaped renderings', () => {
    const v = secretVariants('a&b<c>"d\\e\nf');
    expect(v).toContain('a&amp;b&lt;c&gt;&quot;d\\e\nf');
    expect(v).toContain('a&b<c>\\"d\\\\e\\nf');
    expect(v).toContain('a&b<c>"d\\e<br>f');
  });
});
