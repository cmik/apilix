import { describe, it, expect } from 'vitest';
import { buildTestValueSnippets } from './testSnippetUtils';

describe('buildTestValueSnippets', () => {
  it('builds null assertions plus exists', () => {
    expect(buildTestValueSnippets(['token'], null)).toEqual([
      {
        label: 'Is null',
        snippet: 'apx.test("token is null", () => {\n  apx.expect(apx.response.json()?.token).to.be.null;\n});',
      },
      {
        label: 'Exists (not null/undefined)',
        snippet: 'apx.test("token exists", () => {\n  apx.expect(apx.response.json()?.token).to.exist;\n});',
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

  it('escapes unusual field names safely in test titles', () => {
    const snippets = buildTestValueSnippets(['bad"key'], true);

    expect(snippets[0]?.snippet).toContain('apx.test("bad\\"key is true", () => {');
    expect(snippets[0]?.snippet).toContain('apx.expect(apx.response.json()?.["bad\\"key"]).to.be.true;');
  });
});