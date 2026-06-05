import { describe, it, expect } from 'vitest';
import { buildCollectionDefinitionVarMap, resolveVariables, buildVarMap, getUrlDisplay, extractUsedVariables } from './variableResolver';

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

describe('extractUsedVariables', () => {
  const envVars = { mongoUri: 'mongodb://localhost', mongoDb: 'mydb' };
  const collVars = { collVar: 'coll_value' };
  const globals = { globalToken: 'gval' };
  const collectionDef = { staticKey: 'static_value' };

  it('returns empty array for text with no tokens', () => {
    expect(extractUsedVariables('no tokens here', envVars, collVars, globals)).toHaveLength(0);
  });

  it('returns empty array for non-string input', () => {
    expect(extractUsedVariables(null as unknown as string, envVars, collVars, globals)).toHaveLength(0);
  });

  it('detects a variable resolved from env scope', () => {
    const result = extractUsedVariables('{{mongoUri}}', envVars, collVars, globals, collectionDef);
    expect(result).toEqual([
      { name: 'mongoUri', resolvedValue: 'mongodb://localhost', scope: 'ENV', isEditable: true },
    ]);
  });

  it('detects a variable resolved from collection vars scope', () => {
    const result = extractUsedVariables('{{collVar}}', envVars, collVars, globals, collectionDef);
    expect(result[0]).toMatchObject({ name: 'collVar', scope: 'COLL', resolvedValue: 'coll_value', isEditable: true });
  });

  it('detects a variable resolved from globals scope', () => {
    const result = extractUsedVariables('{{globalToken}}', envVars, collVars, globals, collectionDef);
    expect(result[0]).toMatchObject({ name: 'globalToken', scope: 'GLOBAL', resolvedValue: 'gval', isEditable: true });
  });

  it('detects a variable from collection definition scope as non-editable', () => {
    const result = extractUsedVariables('{{staticKey}}', envVars, collVars, globals, collectionDef);
    expect(result[0]).toMatchObject({ name: 'staticKey', scope: 'COLLECTION_DEF', resolvedValue: 'static_value', isEditable: false });
  });

  it('marks unknown variables as UNRESOLVED with empty resolvedValue', () => {
    const result = extractUsedVariables('{{unknownVar}}', envVars, collVars, globals, collectionDef);
    expect(result[0]).toMatchObject({ name: 'unknownVar', scope: 'UNRESOLVED', resolvedValue: '', isEditable: true });
  });

  it('marks dynamic tokens as DYNAMIC and non-editable', () => {
    const result = extractUsedVariables('{{$guid}}', envVars, collVars, globals);
    expect(result[0]).toMatchObject({ name: '$guid', scope: 'DYNAMIC', isEditable: false });
  });

  it('deduplicates the same variable used multiple times', () => {
    const result = extractUsedVariables('{{mongoDb}} and {{mongoDb}} again', envVars, collVars, globals);
    expect(result.filter(r => r.name === 'mongoDb')).toHaveLength(1);
  });

  it('trims whitespace inside placeholder names', () => {
    const result = extractUsedVariables('{{ mongoUri }}', envVars, collVars, globals);
    expect(result[0]).toMatchObject({ name: 'mongoUri', scope: 'ENV' });
  });

  it('extracts multiple variables from a JSON-like Mongo filter string', () => {
    const text = '{"filter": "{\\\"userId\\\": \\\"{{userId}}\\\", \\\"age\\\": { \\\"$gt\\\": {{minAge}} } }"}';
    const result = extractUsedVariables(text, { userId: 'abc', minAge: '18' }, {}, {});
    const names = result.map(r => r.name);
    expect(names).toContain('userId');
    expect(names).toContain('minAge');
  });

  it('env scope wins over coll/global when the same key is in multiple scopes', () => {
    const result = extractUsedVariables('{{shared}}', { shared: 'from-env' }, { shared: 'from-coll' }, { shared: 'from-global' });
    expect(result[0]).toMatchObject({ name: 'shared', scope: 'ENV', resolvedValue: 'from-env' });
  });

  it('coll scope wins over global when env is absent', () => {
    const result = extractUsedVariables('{{shared}}', {}, { shared: 'from-coll' }, { shared: 'from-global' });
    expect(result[0]).toMatchObject({ name: 'shared', scope: 'COLL', resolvedValue: 'from-coll' });
  });

  it('preserves first-appearance order', () => {
    const result = extractUsedVariables('{{mongoDb}} {{mongoUri}} {{collVar}}', envVars, collVars, globals);
    expect(result.map(r => r.name)).toEqual(['mongoDb', 'mongoUri', 'collVar']);
  });

  it('does not treat prototype property names as resolved (prototype-chain safety)', () => {
    // 'toString' and 'constructor' exist on every plain object via the prototype chain.
    // They must not be classified as ENV/COLL/GLOBAL/COLLECTION_DEF variables.
    const result = extractUsedVariables('{{toString}} {{constructor}}', {}, {}, {});
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: 'toString', scope: 'UNRESOLVED' });
    expect(result[1]).toMatchObject({ name: 'constructor', scope: 'UNRESOLVED' });
  });

  it('does not misclassify a prototype property that happens to share a name with a var key', () => {
    // 'valueOf' is on the prototype; passing an object without an own 'valueOf' key
    // must not resolve it from the prototype chain.
    const result = extractUsedVariables('{{valueOf}}', {}, {}, {});
    expect(result[0]).toMatchObject({ name: 'valueOf', scope: 'UNRESOLVED', resolvedValue: '' });
  });

  it('correctly resolves a variable whose name matches a prototype property when explicitly set', () => {
    // If the user deliberately adds 'toString' as an env var it should be treated as ENV.
    const result = extractUsedVariables('{{toString}}', { toString: 'myvalue' }, {}, {});
    expect(result[0]).toMatchObject({ name: 'toString', scope: 'ENV', resolvedValue: 'myvalue' });
  });
});
