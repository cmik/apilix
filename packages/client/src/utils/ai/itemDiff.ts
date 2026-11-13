import type { CollectionItem } from '../../types';

/** Line diff and field diff used by the AI proposal dialog. Pure, no dependency. */

export interface DiffLine { type: 'same' | 'add' | 'del'; text: string }

const MAX_DIFF_LINES = 400;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  // Beyond the cap an LCS table is not worth it: show a full replacement.
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map(text => ({ type: 'del' as const, text })), ...b.map(text => ({ type: 'add' as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some(l => l.type !== 'same');
}

/** Flat, comparable, display-ready view of the parts of a request the AI can change. */
export interface ItemView {
  name: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  auth: string;
  preRequest: string;
  tests: string;
}

function execText(exec: unknown): string {
  return Array.isArray(exec) ? exec.join('\n') : typeof exec === 'string' ? exec : '';
}

function rows(list: Array<{ key?: string; value?: string; disabled?: boolean }> | undefined): string {
  return (list ?? []).filter(r => r && r.key).map(r => `${r.disabled ? '# ' : ''}${r.key}: ${r.value ?? ''}`).join('\n');
}

function authLabel(auth: NonNullable<CollectionItem['request']>['auth']): string {
  if (!auth || !auth.type || auth.type === 'inherit') return '';
  const entries = (auth as unknown as Record<string, Array<{ key: string; value: string }> | undefined>)[auth.type];
  const refs = (entries ?? []).filter(e => e.key !== 'in' && e.value).map(e => `${e.key}=${/^\{\{.*\}\}$/.test(e.value) ? e.value : '(set)'}`);
  return [auth.type, ...refs].join(' ');
}

export function itemToView(item: CollectionItem): ItemView {
  const req = item.request;
  const url = typeof req?.url === 'string' ? req.url : req?.url?.raw ?? '';
  const body = req?.body;
  let bodyText = '';
  if (body?.mode === 'raw') bodyText = body.raw ?? '';
  else if (body?.mode === 'formdata') bodyText = rows(body.formdata);
  else if (body?.mode === 'urlencoded') bodyText = rows(body.urlencoded);
  const script = (listen: 'prerequest' | 'test') => (item.event ?? []).filter(e => e.listen === listen).map(e => execText(e.script?.exec)).join('\n');
  return {
    name: item.name ?? '',
    method: req?.method ?? 'GET',
    url,
    headers: rows(req?.header),
    body: bodyText,
    auth: authLabel(req?.auth),
    preRequest: script('prerequest'),
    tests: script('test'),
  };
}

export interface FieldChange { field: keyof ItemView; label: string; before: string; after: string }

const LABELS: Record<keyof ItemView, string> = {
  name: 'Name', method: 'Method', url: 'URL', headers: 'Headers', body: 'Body', auth: 'Auth', preRequest: 'Pre-request script', tests: 'Tests',
};

/** Fields that differ between two views, in display order. */
export function diffViews(before: ItemView, after: ItemView): FieldChange[] {
  return (Object.keys(LABELS) as Array<keyof ItemView>)
    .filter(field => before[field] !== after[field])
    .map(field => ({ field, label: LABELS[field], before: before[field], after: after[field] }));
}
