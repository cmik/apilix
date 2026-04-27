import { describe, it, expect } from 'vitest';
import { buildJsonPathDisplayExpression, buildTestValueSnippets, buildSaveToVarSnippet } from './testSnippetUtils';

describe('buildJsonPathDisplayExpression', () => {
  it('formats identifier, numeric, and quoted segments consistently', () => {
    expect(buildJsonPathDisplayExpression(['data', 0, 'token'])).toBe('$.data[0].token');
    expect(buildJsonPathDisplayExpression(['my-key'])).toBe('$["my-key"]');
    expect(buildJsonPathDisplayExpression(['bad"key'])).toBe('$["bad\\"key"]');
    expect(buildJsonPathDisplayExpression([])).toBe('$');
  });
});

describe('buildTestValueSnippets', () => {
  it('builds only null-specific assertions for null values', () => {
    expect(buildTestValueSnippets(['token'], null)).toEqual([
      {
        label: 'Is null',
        snippet: 'apx.test("token is null", () => {\n  apx.expect(apx.response.json()?.token).to.be.null;\n});',
      },
    ]);
  });

  it('builds numeric assertions based on the actual number', () => {
    expect(buildTestValueSnippets(['data', 0, 'count'], 7)).toEqual([
      {
        label: 'Equals 7',
        snippet: 'apx.test("count equals 7", () => {\n  apx.expect(apx.response.json()?.data?.[0]?.count).to.eql(7);\n});',
      },
      {
        label: 'Is a number',
        snippet: 'apx.test("count is a number", () => {\n  apx.expect(apx.response.json()?.data?.[0]?.count).to.be.a(\'number\');\n});',
      },
      {
        label: 'Is positive',
        snippet: 'apx.test("count is positive", () => {\n  apx.expect(apx.response.json()?.data?.[0]?.count).to.be.positive;\n});',
      },
      {
        label: 'Is an integer',
        snippet: 'apx.test("count is an integer", () => {\n  apx.expect(apx.response.json()?.data?.[0]?.count).to.be.integer;\n});',
      },
      {
        label: 'Exists (not null/undefined)',
        snippet: 'apx.test("count exists", () => {\n  apx.expect(apx.response.json()?.data?.[0]?.count).to.exist;\n});',
      },
    ]);
  });

  it('omits contains for long strings and still builds string checks', () => {
    const snippets = buildTestValueSnippets(['profile', 'name'], 'abcdefghijklmnopqrstuvwxyz1234567890');

    expect(snippets.map(s => s.label)).toEqual([
      'Equals "abcdefghijklmnopqrstuvwxyz1..."',
      'Is not empty',
      'Is a string',
      'Exists (not null/undefined)',
    ]);
    expect(snippets[0]?.snippet).toContain('apx.expect(apx.response.json()?.profile?.name).to.eql("abcdefghijklmnopqrstuvwxyz1234567890");');
  });

  it('does not suggest non-empty assertions for empty strings', () => {
    expect(buildTestValueSnippets(['profile', 'name'], '').map(s => s.label)).toEqual([
      'Equals ""',
      'Is a string',
      'Exists (not null/undefined)',
    ]);
  });

  it('escapes unusual field names safely in test titles', () => {
    const snippets = buildTestValueSnippets(['bad"key'], true);

    expect(snippets[0]?.snippet).toContain('apx.test("bad\\"key is true", () => {');
    expect(snippets[0]?.snippet).toContain('apx.expect(apx.response.json()?.["bad\\"key"]).to.be.true;');
  });
});

describe('buildSaveToVarSnippet', () => {
  it('generates environment.set snippet for simple path', () => {
    expect(buildSaveToVarSnippet('token', 'environment', ['data', 'token'])).toBe(
      "apx.environment.set('token', apx.response.json()?.data?.token);"
    );
  });

  it('generates globals.set snippet', () => {
    expect(buildSaveToVarSnippet('myVar', 'globals', ['result'])).toBe(
      "apx.globals.set('myVar', apx.response.json()?.result);"
    );
  });

  it('generates collection.set snippet', () => {
    expect(buildSaveToVarSnippet('userId', 'collection', ['users', 0, 'id'])).toBe(
      "apx.collection.set('userId', apx.response.json()?.users?.[0]?.id);"
    );
  });

  it('uses bracket notation for non-identifier path segments', () => {
    expect(buildSaveToVarSnippet('val', 'environment', ['my-key'])).toBe(
      'apx.environment.set(\'val\', apx.response.json()?.["my-key"]);'
    );
  });

  it('generates snippet for root-level (empty path)', () => {
    expect(buildSaveToVarSnippet('body', 'environment', [])).toBe(
      "apx.environment.set('body', apx.response.json());"
    );
  });
});