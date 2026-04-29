import { describe, expect, it } from 'vitest';
import {
  applyVariableSuggestion,
  buildAllVariableSuggestions,
  buildVariableSuggestions,
  DYNAMIC_VARIABLE_SUGGESTIONS,
  filterVariableSuggestions,
  findVariableToken,
} from './variableAutocomplete';

describe('buildVariableSuggestions', () => {
  it('sorts suggestion names alphabetically and preserves values', () => {
    expect(buildVariableSuggestions({ zebra: 'z', Alpha: 'a', beta: 'b' })).toEqual([
      { name: 'Alpha', value: 'a' },
      { name: 'beta', value: 'b' },
      { name: 'zebra', value: 'z' },
    ]);
  });
});

describe('findVariableToken', () => {
  it('detects an unfinished variable token before the cursor', () => {
    expect(findVariableToken('{"id":"{{use"}', 12)).toEqual({ openIndex: 7, query: 'use' });
  });

  it('ignores closed placeholders', () => {
    expect(findVariableToken('{{userId}}', 10)).toBeNull();
  });

  it('uses the nearest unfinished opening braces', () => {
    expect(findVariableToken('{{done}} {{na', 13)).toEqual({ openIndex: 9, query: 'na' });
  });

  it('trims whitespace inside the unfinished token', () => {
    expect(findVariableToken('{{  token', 9)).toEqual({ openIndex: 0, query: 'token' });
  });
});

describe('filterVariableSuggestions', () => {
  const suggestions = [
    { name: 'baseUrl', value: 'https://api.example.com' },
    { name: 'bearerToken', value: 'abc' },
    { name: 'userId', value: '42' },
  ];

  it('returns all suggestions when the query is empty', () => {
    expect(filterVariableSuggestions(suggestions, '')).toEqual(suggestions);
  });

  it('filters suggestions case-insensitively by prefix', () => {
    expect(filterVariableSuggestions(suggestions, 'BE')).toEqual([
      { name: 'bearerToken', value: 'abc' },
    ]);
  });
});

describe('applyVariableSuggestion', () => {
  it('replaces the unfinished token and moves the cursor after the closing braces', () => {
    expect(applyVariableSuggestion('{"url":"{{bas"}', 13, 'baseUrl')).toEqual({
      value: '{"url":"{{baseUrl}}"}',
      cursor: 19,
    });
  });

  it('preserves trailing text after the cursor', () => {
    expect(applyVariableSuggestion('{{us-er}} suffix {{na middle', 21, 'name')).toEqual({
      value: '{{us-er}} suffix {{name}} middle',
      cursor: 25,
    });
  });

  it('returns null when no unfinished token is active', () => {
    expect(applyVariableSuggestion('plain text', 5, 'name')).toBeNull();
  });
});

describe('DYNAMIC_VARIABLE_SUGGESTIONS', () => {
  it('contains the four expected dynamic tokens', () => {
    const names = DYNAMIC_VARIABLE_SUGGESTIONS.map(s => s.name);
    expect(names).toContain('$guid');
    expect(names).toContain('$timestamp');
    expect(names).toContain('$isoTimestamp');
    expect(names).toContain('$randomInt');
  });

  it('each entry has a non-empty descriptive value', () => {
    for (const s of DYNAMIC_VARIABLE_SUGGESTIONS) {
      expect(s.value).toBeTruthy();
    }
  });
});

describe('buildAllVariableSuggestions', () => {
  it('returns all 4 dynamic entries when vars is empty', () => {
    const result = buildAllVariableSuggestions({});
    expect(result).toEqual(DYNAMIC_VARIABLE_SUGGESTIONS);
  });

  it('prepends dynamic entries before user-defined variables', () => {
    const result = buildAllVariableSuggestions({ baseUrl: 'http://example.com' });
    const names = result.map(s => s.name);
    const firstUserIndex = names.indexOf('baseUrl');
    const lastDynamicIndex = Math.max(...DYNAMIC_VARIABLE_SUGGESTIONS.map(d => names.indexOf(d.name)));
    expect(lastDynamicIndex).toBeLessThan(firstUserIndex);
  });

  it('user vars are still sorted alphabetically after dynamic entries', () => {
    const result = buildAllVariableSuggestions({ zebra: 'z', alpha: 'a' });
    const names = result.map(s => s.name);
    const dynamicCount = DYNAMIC_VARIABLE_SUGGESTIONS.length;
    expect(names[dynamicCount]).toBe('alpha');
    expect(names[dynamicCount + 1]).toBe('zebra');
  });

  it('filterVariableSuggestions with $ prefix returns dynamic tokens', () => {
    const all = buildAllVariableSuggestions({});
    const filtered = filterVariableSuggestions(all, '$');
    expect(filtered.map(s => s.name)).toEqual(DYNAMIC_VARIABLE_SUGGESTIONS.map(s => s.name));
  });

  it('filterVariableSuggestions with $g returns only $guid', () => {
    const all = buildAllVariableSuggestions({});
    const filtered = filterVariableSuggestions(all, '$g');
    expect(filtered.map(s => s.name)).toEqual(['$guid']);
  });

  it('filterVariableSuggestions with g returns user var "guid" but not $guid', () => {
    const all = buildAllVariableSuggestions({ guid: 'some-fixed-value' });
    const filtered = filterVariableSuggestions(all, 'g');
    const names = filtered.map(s => s.name);
    expect(names).toContain('guid');
    expect(names).not.toContain('$guid');
  });
});
