import { describe, it, expect } from 'vitest';
import { DEFAULT_AI_SETTINGS, mergeAiSettings, normalizeBaseUrl, validateAiSettings, isHttpUrl } from './aiDefaults';

describe('aiDefaults', () => {
  it('defaults are opt-in and conservative', () => {
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_AI_SETTINGS.consentGiven).toBe(false);
    expect(DEFAULT_AI_SETTINGS.redactSecrets).toBe(true);
    expect(DEFAULT_AI_SETTINGS.maxContextTokens).toBe(8000);
  });

  it('normalizeBaseUrl trims and drops trailing slashes', () => {
    expect(normalizeBaseUrl('  http://localhost:11434/v1/// ')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl(undefined)).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
  });

  it('isHttpUrl only accepts http(s)', () => {
    expect(isHttpUrl('https://a.b')).toBe(true);
    expect(isHttpUrl('http://localhost:1234/v1')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('nope')).toBe(false);
  });

  it('validateAiSettings flags bad URL, bad limit and missing model when enabled', () => {
    const ok = { ...DEFAULT_AI_SETTINGS, enabled: true, model: 'm' };
    expect(validateAiSettings(ok)).toBeNull();
    expect(validateAiSettings({ ...ok, baseUrl: 'ftp://x' })).toMatch(/Base URL/);
    expect(validateAiSettings({ ...ok, maxContextTokens: 10 })).toMatch(/Max context/);
    expect(validateAiSettings({ ...ok, maxContextTokens: 1.5 })).toMatch(/Max context/);
    expect(validateAiSettings({ ...ok, model: '  ' })).toMatch(/model/i);
    expect(validateAiSettings({ ...DEFAULT_AI_SETTINGS, enabled: false })).toBeNull();
  });

  it('mergeAiSettings keeps unspecified features', () => {
    const m = mergeAiSettings(DEFAULT_AI_SETTINGS, { features: { dataGen: true } });
    expect(m.features.dataGen).toBe(true);
    expect(m.features.diagnose).toBe(false);
    expect(DEFAULT_AI_SETTINGS.features.dataGen).toBe(false);
  });
});
