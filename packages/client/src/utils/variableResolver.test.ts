import { describe, it, expect } from 'vitest';
import { buildCollectionDefinitionVarMap, resolveVariables, buildVarMap, getUrlDisplay } from './variableResolver';

describe('resolveVariables', () => {
  it('substitutes a known variable', () => {
    expect(resolveVariables('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('passes through unknown variables as-is', () => {
    expect(resolveVariables('Hello {{unknown}}', {})).toBe('Hello {{unknown}}');
  });

  it('substitutes multiple placeholders in one string', () => {
    expect(resolveVariables('{{proto}}://{{host}}', { proto: 'https', host: 'api.example.com' }))
      .toBe('https://api.example.com');
  });

  it('trims whitespace inside placeholder name', () => {
    expect(resolveVariables('{{ name }}', { name: 'Alice' })).toBe('Alice');
  });

  it('returns empty string unchanged', () => {
    expect(resolveVariables('', {})).toBe('');
  });

  it('replaces only the matched placeholder, leaves surrounding text intact', () => {
    expect(resolveVariables('/api/v1/{{id}}/items', { id: '42' })).toBe('/api/v1/42/items');
  });

  it('handles falsy input gracefully', () => {
    expect(resolveVariables(null as unknown as string, {})).toBe(null);
    expect(resolveVariables(undefined as unknown as string, {})).toBe(undefined);
  });
});

describe('buildVarMap', () => {
  const collectionDefinitionVars = { s: 'static', shared: 'from-static' };
  const globals = { g: 'global', shared: 'from-global' };
  const collVars = { c: 'collvar', shared: 'from-collvar' };
  const env = { e: 'env', shared: 'from-env' };
  const dataRow = { d: 'data', shared: 'from-data' };

  it('merges all five scopes', () => {
    const map = buildVarMap(env, collVars, globals, dataRow, collectionDefinitionVars);
    expect(map.s).toBe('static');
    expect(map.g).toBe('global');
    expect(map.c).toBe('collvar');
    expect(map.e).toBe('env');
    expect(map.d).toBe('data');
  });

  it('priority: dataRow > env > collectionVars > globals > collection definition vars', () => {
    const map = buildVarMap(env, collVars, globals, dataRow, collectionDefinitionVars);
    expect(map.shared).toBe('from-data');
  });

  it('priority: env > collectionVars > globals > collection definition vars (no dataRow)', () => {
    const map = buildVarMap(env, collVars, globals, {}, collectionDefinitionVars);
    expect(map.shared).toBe('from-env');
  });

  it('priority: collectionVars > globals > collection definition vars (no env or dataRow)', () => {
    const map = buildVarMap({}, collVars, globals, {}, collectionDefinitionVars);
    expect(map.shared).toBe('from-collvar');
  });

  it('priority: globals > collection definition vars when higher scopes are absent', () => {
    const map = buildVarMap({}, {}, globals, {}, collectionDefinitionVars);
    expect(map.shared).toBe('from-global');
  });

  it('returns empty object when all inputs are empty', () => {
    expect(buildVarMap({}, {}, {})).toEqual({});
  });
});

describe('buildCollectionDefinitionVarMap', () => {
  it('collects enabled collection definition variables only', () => {
    expect(buildCollectionDefinitionVarMap([
      { key: 'baseUrl', value: 'https://api.example.com' },
      { key: 'disabledVar', value: 'x', disabled: true },
      { key: '', value: 'ignored' },
    ])).toEqual({ baseUrl: 'https://api.example.com' });
  });
});

describe('getUrlDisplay', () => {
  it('passes through a string URL', () => {
    expect(getUrlDisplay('https://example.com', {})).toBe('https://example.com');
  });

  it('extracts raw from a URL object', () => {
    expect(getUrlDisplay({ raw: 'https://api.example.com/v1' }, {})).toBe('https://api.example.com/v1');
  });

  it('resolves variables in a string URL', () => {
    expect(getUrlDisplay('{{baseUrl}}/users', { baseUrl: 'https://api.example.com' }))
      .toBe('https://api.example.com/users');
  });

  it('resolves variables in the raw field of a URL object', () => {
    expect(getUrlDisplay({ raw: '{{host}}/path' }, { host: 'https://example.com' }))
      .toBe('https://example.com/path');
  });

  it('returns empty string for undefined input', () => {
    expect(getUrlDisplay(undefined, {})).toBe('');
  });

  it('returns empty string for URL object without raw', () => {
    expect(getUrlDisplay({} as { raw: string }, {})).toBe('');
  });
});
