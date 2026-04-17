import { describe, expect, it } from 'vitest';
import { compareSemver, isVersionGreater } from './versionUtils';

describe('compareSemver', () => {
  it('returns 0 for equivalent versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
  });

  it('returns positive when left version is newer', () => {
    expect(compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('returns negative when left version is older', () => {
    expect(compareSemver('1.2.2', '1.2.3')).toBeLessThan(0);
    expect(compareSemver('1.9.9', '2.0.0')).toBeLessThan(0);
  });

  it('handles prerelease precedence correctly', () => {
    expect(compareSemver('1.2.3', '1.2.3-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3-beta.2', '1.2.3-beta.10')).toBeLessThan(0);
    expect(compareSemver('1.2.3-beta', '1.2.3-1')).toBeGreaterThan(0);
  });

  it('returns null when a version is not semver', () => {
    expect(compareSemver('main', '1.2.3')).toBeNull();
    expect(compareSemver('1.2.3', 'nightly')).toBeNull();
  });
});

describe('isVersionGreater', () => {
  it('returns true only when candidate is greater than current', () => {
    expect(isVersionGreater('1.2.4', '1.2.3')).toBe(true);
    expect(isVersionGreater('1.2.3', '1.2.3')).toBe(false);
    expect(isVersionGreater('1.2.2', '1.2.3')).toBe(false);
  });

  it('returns false for non-semver input', () => {
    expect(isVersionGreater('nightly', '1.2.3')).toBe(false);
    expect(isVersionGreater('1.2.3', 'nightly')).toBe(false);
  });
});
