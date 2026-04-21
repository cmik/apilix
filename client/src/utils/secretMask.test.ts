import { describe, it, expect } from 'vitest';
import { buildSecretSet, maskSecrets, SECRET_MASK } from './secretMask';
import type { AppEnvironment } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEnv(id: string, values: AppEnvironment['values']): AppEnvironment {
  return { _id: id, name: 'Env', values };
}

// ─── buildSecretSet ──────────────────────────────────────────────────────────

describe('buildSecretSet', () => {
  it('returns empty set when environments array is empty', () => {
    expect(buildSecretSet([], 'e1').size).toBe(0);
  });

  it('returns empty set when active env has empty values array', () => {
    const envs = [makeEnv('e1', [])];
    expect(buildSecretSet(envs, 'e1').size).toBe(0);
  });

  it('returns empty set when activeEnvironmentId is null', () => {
    const envs = [makeEnv('e1', [{ key: 'TOKEN', value: 'secret123', enabled: true, secret: true }])];
    expect(buildSecretSet(envs, null).size).toBe(0);
  });

  it('returns empty set when activeEnvironmentId does not match any env', () => {
    const envs = [makeEnv('e1', [{ key: 'TOKEN', value: 'secret123', enabled: true, secret: true }])];
    expect(buildSecretSet(envs, 'e2').size).toBe(0);
  });

  it('returns empty set when active env has no secret rows', () => {
    const envs = [makeEnv('e1', [{ key: 'BASE_URL', value: 'https://api.example.com', enabled: true }])];
    expect(buildSecretSet(envs, 'e1').size).toBe(0);
  });

  it('includes only rows with secret: true', () => {
    const envs = [makeEnv('e1', [
      { key: 'API_KEY', value: 'supersecret', enabled: true, secret: true },
      { key: 'BASE_URL', value: 'https://api.example.com', enabled: true },
    ])];
    const set = buildSecretSet(envs, 'e1');
    expect(set.has('supersecret')).toBe(true);
    expect(set.has('https://api.example.com')).toBe(false);
  });

  it('excludes rows where secret is explicitly false', () => {
    const envs = [makeEnv('e1', [
      { key: 'KEY', value: 'supersecret', enabled: true, secret: false },
    ])];
    expect(buildSecretSet(envs, 'e1').size).toBe(0);
  });

  it('excludes rows where secret is omitted (undefined)', () => {
    const envs = [makeEnv('e1', [
      { key: 'KEY', value: 'supersecret', enabled: true },
    ])];
    expect(buildSecretSet(envs, 'e1').size).toBe(0);
  });

  it('deduplicates identical values from two secret rows', () => {
    const envs = [makeEnv('e1', [
      { key: 'KEY1', value: 'shared-secret', enabled: true, secret: true },
      { key: 'KEY2', value: 'shared-secret', enabled: true, secret: true },
    ])];
    const set = buildSecretSet(envs, 'e1');
    expect(set.size).toBe(1);
    expect(set.has('shared-secret')).toBe(true);
  });

  it('excludes disabled rows', () => {
    const envs = [makeEnv('e1', [
      { key: 'API_KEY', value: 'supersecret', enabled: false, secret: true },
    ])];
    expect(buildSecretSet(envs, 'e1').size).toBe(0);
  });

  it('excludes values shorter than MIN_SECRET_LEN (4)', () => {
    const envs = [makeEnv('e1', [
      { key: 'SHORT', value: 'abc', enabled: true, secret: true },
      { key: 'OK', value: 'abcd', enabled: true, secret: true },
    ])];
    const set = buildSecretSet(envs, 'e1');
    expect(set.has('abc')).toBe(false);
    expect(set.has('abcd')).toBe(true);
  });

  it('includes multiple secret rows', () => {
    const envs = [makeEnv('e1', [
      { key: 'KEY1', value: 'secretone', enabled: true, secret: true },
      { key: 'KEY2', value: 'secrettwo', enabled: true, secret: true },
    ])];
    const set = buildSecretSet(envs, 'e1');
    expect(set.size).toBe(2);
    expect(set.has('secretone')).toBe(true);
    expect(set.has('secrettwo')).toBe(true);
  });
});

// ─── maskSecrets ─────────────────────────────────────────────────────────────

describe('maskSecrets', () => {
  it('returns text unchanged when secrets set is empty', () => {
    expect(maskSecrets('https://api.example.com?token=abc', new Set())).toBe('https://api.example.com?token=abc');
  });

  it('replaces a single occurrence of a secret', () => {
    const secrets = new Set(['my-secret-token']);
    const result = maskSecrets('Authorization: Bearer my-secret-token', secrets);
    expect(result).toBe(`Authorization: Bearer ${SECRET_MASK}`);
  });

  it('replaces multiple occurrences of the same secret', () => {
    const secrets = new Set(['abc123']);
    const result = maskSecrets('abc123 and abc123 again', secrets);
    expect(result).toBe(`${SECRET_MASK} and ${SECRET_MASK} again`);
  });

  it('replaces occurrences of multiple different secrets', () => {
    const secrets = new Set(['token_a', 'token_b']);
    const result = maskSecrets('Using token_a and token_b here', secrets);
    expect(result).toBe(`Using ${SECRET_MASK} and ${SECRET_MASK} here`);
  });

  it('handles secrets containing regex special characters safely', () => {
    const secrets = new Set(['p@$$w0rd+!']);
    const result = maskSecrets('Password: p@$$w0rd+!', secrets);
    expect(result).toBe(`Password: ${SECRET_MASK}`);
  });

  it('handles secrets containing dot and star without regex issues', () => {
    const secrets = new Set(['a.b*c']);
    const result = maskSecrets('value is a.b*c here', secrets);
    expect(result).toBe(`value is ${SECRET_MASK} here`);
  });

  it('masks the longer secret when one is a prefix of another', () => {
    const secrets = new Set(['mykey', 'mykey_prod']);
    expect(maskSecrets('token: mykey_prod', secrets)).toBe(`token: ${SECRET_MASK}`);
  });

  it('does not mask when the text has no matching secret', () => {
    const secrets = new Set(['other-secret']);
    const text = 'Authorization: Bearer my-token';
    expect(maskSecrets(text, secrets)).toBe(text);
  });

  it('returns empty string unchanged when input is empty', () => {
    expect(maskSecrets('', new Set(['supersecret']))).toBe('');
  });

  it('replaces text that consists solely of the secret', () => {
    const secrets = new Set(['my-token']);
    expect(maskSecrets('my-token', secrets)).toBe(SECRET_MASK);
  });

  it('is case-sensitive — different case is not masked', () => {
    const secrets = new Set(['TOKEN']);
    expect(maskSecrets('Bearer token', secrets)).toBe('Bearer token');
  });

  it('masks longer secret first regardless of insertion order in Set', () => {
    // Longer value inserted into Set first — sort must still put it first
    const secrets = new Set(['mykey_prod', 'mykey']);
    expect(maskSecrets('token: mykey_prod', secrets)).toBe(`token: ${SECRET_MASK}`);
  });

  it('masks the longer secret when one is a suffix of another', () => {
    // "key" is a suffix of "apikey" — "apikey" must be replaced before "key"
    const secrets = new Set(['key', 'apikey']);
    expect(maskSecrets('using apikey here', secrets)).toBe(`using ${SECRET_MASK} here`);
  });

  it('masks secrets appearing in multi-argument script log text', () => {
    const secrets = new Set(['tok-abc123']);
    // Simulates log.args.join(' ') with a secret embedded in one arg
    const logLine = 'token value: tok-abc123 and done';
    expect(maskSecrets(logLine, secrets)).toBe(`token value: ${SECRET_MASK} and done`);
  });
});
