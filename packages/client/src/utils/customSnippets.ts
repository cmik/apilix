/**
 * User snippets ("My snippets" in the script snippet library): stored in localStorage, per script kind.
 * Plain text only; never executed here. Bounded so a runaway save cannot fill the storage.
 */

export type CustomSnippetTarget = 'prerequest' | 'test';

export interface CustomSnippet {
  id: string;
  name: string;
  description: string;
  code: string;
}

export const CUSTOM_SNIPPETS_KEY = 'apilix_custom_snippets_v1';
/** Dispatched on `document` when the stored snippets change, so an open library can refresh. */
export const CUSTOM_SNIPPETS_CHANGED = 'apilix:custom-snippets-changed';
export const MAX_CUSTOM_SNIPPETS = 50;
export const MAX_SNIPPET_CODE_CHARS = 20000;
const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;

type Store = Record<CustomSnippetTarget, CustomSnippet[]>;

function clean(raw: unknown): CustomSnippet[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomSnippet[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.code !== 'string') continue;
    out.push({
      id: o.id.slice(0, 80),
      name: o.name.slice(0, MAX_NAME_CHARS),
      description: typeof o.description === 'string' ? o.description.slice(0, MAX_DESCRIPTION_CHARS) : '',
      code: o.code.slice(0, MAX_SNIPPET_CODE_CHARS),
    });
    if (out.length >= MAX_CUSTOM_SNIPPETS) break;
  }
  return out;
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_SNIPPETS_KEY) ?? '{}') as Partial<Record<CustomSnippetTarget, unknown>>;
    return { prerequest: clean(parsed.prerequest), test: clean(parsed.test) };
  } catch {
    return { prerequest: [], test: [] };
  }
}

function writeStore(store: Store): boolean {
  try {
    localStorage.setItem(CUSTOM_SNIPPETS_KEY, JSON.stringify(store));
  } catch {
    return false; // quota or storage disabled
  }
  try { document.dispatchEvent(new CustomEvent(CUSTOM_SNIPPETS_CHANGED)); } catch { /* no DOM */ }
  return true;
}

export function loadCustomSnippets(target: CustomSnippetTarget): CustomSnippet[] {
  return readStore()[target];
}

export type AddSnippetResult = { ok: true; snippet: CustomSnippet } | { ok: false; reason: 'empty' | 'too-long' | 'limit' | 'storage' };

export function addCustomSnippet(target: CustomSnippetTarget, input: { name: string; description?: string; code: string }): AddSnippetResult {
  const code = input.code.replace(/\s+$/, '');
  if (!code.trim()) return { ok: false, reason: 'empty' };
  if (code.length > MAX_SNIPPET_CODE_CHARS) return { ok: false, reason: 'too-long' };
  const store = readStore();
  if (store[target].length >= MAX_CUSTOM_SNIPPETS) return { ok: false, reason: 'limit' };
  const snippet: CustomSnippet = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: (input.name.trim() || 'AI snippet').slice(0, MAX_NAME_CHARS),
    description: (input.description ?? '').trim().slice(0, MAX_DESCRIPTION_CHARS),
    code,
  };
  store[target] = [snippet, ...store[target]];
  return writeStore(store) ? { ok: true, snippet } : { ok: false, reason: 'storage' };
}

export function removeCustomSnippet(target: CustomSnippetTarget, id: string): void {
  const store = readStore();
  store[target] = store[target].filter(s => s.id !== id);
  writeStore(store);
}
