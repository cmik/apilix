import { describe, it, expect } from 'vitest';
import { mergeJson, mergeText } from './textMerge';

// ─── mergeJson ────────────────────────────────────────────────────────────────

describe('mergeJson', () => {
  it('returns null when inputs are not JSON objects', () => {
    expect(mergeJson('"string"', '"string"', '"string"')).toBeNull();
    expect(mergeJson('42', '42', '42')).toBeNull();
    expect(mergeJson('invalid', '{}', '{}')).toBeNull();
  });

  it('auto-merges when only local changed a field', () => {
    const base = JSON.stringify({ a: 1, b: 2 });
    const local = JSON.stringify({ a: 99, b: 2 });
    const remote = JSON.stringify({ a: 1, b: 2 });
    const result = mergeJson(base, local, remote)!;
    expect(result.autoMerged).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ a: 99, b: 2 });
  });

  it('auto-merges when only remote changed a field', () => {
    const base = JSON.stringify({ x: 'old' });
    const local = JSON.stringify({ x: 'old' });
    const remote = JSON.stringify({ x: 'new' });
    const result = mergeJson(base, local, remote)!;
    expect(result.autoMerged).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ x: 'new' });
  });

  it('auto-merges non-overlapping changes from both sides', () => {
    const base = JSON.stringify({ a: 1, b: 2 });
    const local = JSON.stringify({ a: 99, b: 2 });
    const remote = JSON.stringify({ a: 1, b: 77 });
    const result = mergeJson(base, local, remote)!;
    expect(result.autoMerged).toBe(true);
    const merged = JSON.parse(result.text);
    expect(merged.a).toBe(99);
    expect(merged.b).toBe(77);
  });

  it('auto-merges when both sides made the same change', () => {
    const base = JSON.stringify({ a: 1 });
    const both = JSON.stringify({ a: 42 });
    const result = mergeJson(base, both, both)!;
    expect(result.autoMerged).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ a: 42 });
  });

  it('reports a conflict when both sides changed the same field to different values', () => {
    const base = JSON.stringify({ key: 'base' });
    const local = JSON.stringify({ key: 'local' });
    const remote = JSON.stringify({ key: 'remote' });
    const result = mergeJson(base, local, remote)!;
    expect(result.autoMerged).toBe(false);
    expect(result.hunks.some(h => h.isConflict)).toBe(true);
  });

  it('auto-merges local key deletion', () => {
    const base = JSON.stringify({ keep: 1, remove: 2 });
    const local = JSON.stringify({ keep: 1 });
    const remote = JSON.stringify({ keep: 1, remove: 2 });
    const result = mergeJson(base, local, remote)!;
    expect(result.autoMerged).toBe(true);
    expect('remove' in JSON.parse(result.text)).toBe(false);
  });

  it('auto-merges a new key added by remote', () => {
    const base = JSON.stringify({ a: 1 });
    const local = JSON.stringify({ a: 1 });
    const remote = JSON.stringify({ a: 1, b: 2 });
    const result = mergeJson(base, local, remote)!;
    expect(result.autoMerged).toBe(true);
    expect(JSON.parse(result.text).b).toBe(2);
  });
});

// ─── mergeText ────────────────────────────────────────────────────────────────

describe('mergeText', () => {
  it('returns the common text when all three versions are identical', () => {
    const text = 'line1\nline2\nline3';
    const result = mergeText(text, text, text);
    expect(result.autoMerged).toBe(true);
    expect(result.text).toBe(text);
    expect(result.hunks).toHaveLength(0);
  });

  it('auto-resolves when only local changed a line', () => {
    const base = 'a\nb\nc';
    const local = 'a\nBBB\nc';
    const remote = 'a\nb\nc';
    const result = mergeText(base, local, remote);
    expect(result.autoMerged).toBe(true);
    expect(result.text).toContain('BBB');
    expect(result.text).not.toContain('\nb\n');
  });

  it('auto-resolves when only remote changed a line', () => {
    const base = 'a\nb\nc';
    const local = 'a\nb\nc';
    const remote = 'a\nRRR\nc';
    const result = mergeText(base, local, remote);
    expect(result.autoMerged).toBe(true);
    expect(result.text).toContain('RRR');
  });

  it('auto-resolves non-overlapping changes', () => {
    const base = 'a\nb\nc\nd';
    const local = 'A\nb\nc\nd';  // changed line 1
    const remote = 'a\nb\nc\nD'; // changed line 4
    const result = mergeText(base, local, remote);
    expect(result.autoMerged).toBe(true);
    expect(result.text).toContain('A');
    expect(result.text).toContain('D');
  });

  it('auto-resolves when both sides made the same change', () => {
    const base = 'a\nb\nc';
    const both = 'a\nSAME\nc';
    const result = mergeText(base, both, both);
    expect(result.autoMerged).toBe(true);
    expect(result.text).toContain('SAME');
  });

  it('marks a conflict when both sides changed the same line differently', () => {
    const base = 'a\nb\nc';
    const local = 'a\nLOCAL\nc';
    const remote = 'a\nREMOTE\nc';
    const result = mergeText(base, local, remote);
    expect(result.autoMerged).toBe(false);
    expect(result.hunks.some(h => h.isConflict)).toBe(true);
  });

  it('handles empty base string', () => {
    const result = mergeText('', 'added by local', 'added by local');
    expect(result.autoMerged).toBe(true);
  });
});
