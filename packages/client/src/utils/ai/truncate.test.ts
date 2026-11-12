import { describe, expect, it } from 'vitest';
import { MAX_AI_BODY_CHARS, truncateForAi } from './truncate';

describe('truncateForAi', () => {
  it('leaves a small body alone', () => {
    expect(truncateForAi('abc')).toEqual({ text: 'abc', truncated: false });
  });
  it('cuts at 900000 characters and reports it', () => {
    const r = truncateForAi('x'.repeat(MAX_AI_BODY_CHARS + 5));
    expect(r.text).toHaveLength(MAX_AI_BODY_CHARS);
    expect(r.truncated).toBe(true);
  });
  it('also respects a byte budget for multi-byte text', () => {
    const r = truncateForAi('€'.repeat(MAX_AI_BODY_CHARS));
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(1_800_000);
    expect(r.truncated).toBe(true);
  });
  it('counts the JSON-escaped size: control characters and quotes grow when escaped', () => {
    for (const ch of ['\u0001', '"', '\n']) {
      const r = truncateForAi(ch.repeat(MAX_AI_BODY_CHARS));
      expect(new TextEncoder().encode(JSON.stringify(r.text)).length).toBeLessThanOrEqual(1_800_000);
      expect(r.truncated).toBe(true);
    }
  });
  it('never ends on half of a surrogate pair', () => {
    const r = truncateForAi('a' + '\u{1F600}'.repeat(MAX_AI_BODY_CHARS / 2 + 10));
    expect(r.text).not.toMatch(/[\ud800-\udbff]$/);
    expect(new TextEncoder().encode(JSON.stringify(r.text)).length).toBeLessThanOrEqual(1_800_000);
  });
});
