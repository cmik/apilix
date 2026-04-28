import { describe, expect, it } from 'vitest';
import {
  applyVariableSuggestion,
  buildVariableSuggestions,
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