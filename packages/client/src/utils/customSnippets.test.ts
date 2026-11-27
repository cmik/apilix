// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addCustomSnippet, loadCustomSnippets, removeCustomSnippet,
  CUSTOM_SNIPPETS_KEY, CUSTOM_SNIPPETS_CHANGED, MAX_CUSTOM_SNIPPETS, MAX_SNIPPET_CODE_CHARS,
} from './customSnippets';

describe('customSnippets', () => {
  beforeEach(() => localStorage.clear());

  it('adds, lists newest first, keeps kinds apart and removes', () => {
    const a = addCustomSnippet('test', { name: 'A', code: 'apx.test("a", () => {});\n\n' });
    const b = addCustomSnippet('test', { name: 'B', description: 'second', code: 'apx.test("b", () => {});' });
    addCustomSnippet('prerequest', { name: 'P', code: 'apx.environment.set("x", "1");' });
    expect(a.ok && b.ok).toBe(true);
    expect(loadCustomSnippets('test').map(s => s.name)).toEqual(['B', 'A']);
    expect(loadCustomSnippets('test')[1].code).toBe('apx.test("a", () => {});'); // trailing whitespace trimmed
    expect(loadCustomSnippets('prerequest')).toHaveLength(1);
    if (b.ok) removeCustomSnippet('test', b.snippet.id);
    expect(loadCustomSnippets('test').map(s => s.name)).toEqual(['A']);
  });

  it('names an unnamed snippet and bounds name and description', () => {
    const r = addCustomSnippet('test', { name: '  ', description: 'd'.repeat(500), code: 'x' });
    expect(r.ok && r.snippet.name).toBe('AI snippet');
    expect(r.ok && r.snippet.description.length).toBe(200);
    const long = addCustomSnippet('test', { name: 'n'.repeat(300), code: 'x' });
    expect(long.ok && long.snippet.name.length).toBe(80);
  });

  it('refuses empty, oversized and beyond-the-limit snippets', () => {
    expect(addCustomSnippet('test', { name: 'x', code: '   \n' })).toEqual({ ok: false, reason: 'empty' });
    expect(addCustomSnippet('test', { name: 'x', code: 'a'.repeat(MAX_SNIPPET_CODE_CHARS + 1) })).toEqual({ ok: false, reason: 'too-long' });
    for (let i = 0; i < MAX_CUSTOM_SNIPPETS; i++) expect(addCustomSnippet('test', { name: `s${i}`, code: 'x' }).ok).toBe(true);
    expect(addCustomSnippet('test', { name: 'one more', code: 'x' })).toEqual({ ok: false, reason: 'limit' });
  });

  it('survives corrupted storage and drops malformed entries', () => {
    localStorage.setItem(CUSTOM_SNIPPETS_KEY, '{not json');
    expect(loadCustomSnippets('test')).toEqual([]);
    localStorage.setItem(CUSTOM_SNIPPETS_KEY, JSON.stringify({ test: [null, 5, { id: 1 }, { id: 'ok', name: 'n', code: 'c' }], prerequest: 'x' }));
    expect(loadCustomSnippets('test')).toEqual([{ id: 'ok', name: 'n', description: '', code: 'c' }]);
    expect(loadCustomSnippets('prerequest')).toEqual([]);
  });

  it('reports a storage failure instead of throwing, and announces changes', () => {
    const changed = vi.fn();
    document.addEventListener(CUSTOM_SNIPPETS_CHANGED, changed);
    expect(addCustomSnippet('test', { name: 'a', code: 'x' }).ok).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(addCustomSnippet('test', { name: 'b', code: 'y' })).toEqual({ ok: false, reason: 'storage' });
    spy.mockRestore();
    document.removeEventListener(CUSTOM_SNIPPETS_CHANGED, changed);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
