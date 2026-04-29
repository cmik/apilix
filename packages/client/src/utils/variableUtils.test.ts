import { describe, it, expect } from 'vitest';
import { normalizeVariableName, isValidVariableName, storageKeyError } from './variableUtils';

describe('normalizeVariableName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeVariableName('  token  ')).toBe('token');
  });
  it('replaces internal spaces with underscores', () => {
    expect(normalizeVariableName('my var')).toBe('my_var');
  });
  it('replaces multiple spaces with a single underscore', () => {
    expect(normalizeVariableName('my  var  name')).toBe('my_var_name');
  });
  it('leaves valid names unchanged', () => {
    expect(normalizeVariableName('accessToken')).toBe('accessToken');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeVariableName('')).toBe('');
  });
  it('handles only spaces', () => {
    expect(normalizeVariableName('   ')).toBe('');
  });
});

describe('isValidVariableName', () => {
  it('returns true for a plain key', () => {
    expect(isValidVariableName('token')).toBe(true);
  });
  it('returns false for empty string', () => {
    expect(isValidVariableName('')).toBe(false);
  });
  it('returns false for whitespace-only string', () => {
    expect(isValidVariableName('   ')).toBe(false);
  });
});

describe('storageKeyError', () => {
  it('returns null for a plain key', () => {
    expect(storageKeyError('token')).toBeNull();
  });
  it('returns null for hyphenated keys', () => {
    expect(storageKeyError('api-key')).toBeNull();
  });
  it('returns null for complex names like X-Token-2', () => {
    expect(storageKeyError('X-Token-2')).toBeNull();
  });
  it('returns null for empty string (neutral / not yet typed)', () => {
    expect(storageKeyError('')).toBeNull();
  });
  it('returns error for a key with internal space', () => {
    expect(storageKeyError('my token')).toBe('Variable names cannot contain spaces or whitespace');
  });
  it('returns error for a key with leading space', () => {
    expect(storageKeyError(' token')).toBe('Variable names cannot contain spaces or whitespace');
  });
  it('returns error for a key with tab', () => {
    expect(storageKeyError('to\tken')).toBe('Variable names cannot contain spaces or whitespace');
  });
  it('returns error for a key containing braces', () => {
    expect(storageKeyError('{{token}}')).toBe('Variable names cannot contain { or }');
  });
  it('returns error for a key with opening brace', () => {
    expect(storageKeyError('tok{en')).toBe('Variable names cannot contain { or }');
  });
});
