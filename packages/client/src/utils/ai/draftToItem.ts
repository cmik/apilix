import type { CollectionAuth, CollectionBody, CollectionEvent, CollectionHeader, CollectionItem, CollectionQueryParam, CollectionRequest, CollectionUrl } from '../../types';
import type { RequestDraft, RequestDraftAuth, RequestDraftBody, RequestDraftPair } from './aiTypes';

/**
 * Pure mapping from a model-written request draft to a collection item.
 *
 * Guarantees (covered by tests against the Postman v2.1 validator):
 *  - whatever the draft contains, the result is a valid Postman item: known method, string url
 *    parts, headers/params as {key, value}, a body only when it has content, auth only in
 *    Postman's shapes, scripts as `exec` line arrays;
 *  - nothing is executed or sent, and no field is trusted: strings are coerced and bounded.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MAX_NAME = 200;
const MAX_URL = 2000;
const MAX_VALUE = 2000;
const MAX_PAIRS = 40;
const MAX_RAW = 20000;
const MAX_SCRIPT = 12000;
const CAPTURE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;
const CAPTURE_PATH_RE = /^(?:header:[A-Za-z0-9-]{1,80}|[A-Za-z_$][\w$-]{0,60}(?:\.[\w$-]{1,60}|\[\d{1,3}\]){0,8})$/;

export interface DraftToItemOptions {
  /** Id of the new item (a random one by default). */
  id?: string;
  /**
   * Item being modified. Its id, description, saved examples, request settings and (when the
   * draft carries none) auth are preserved: a draft only replaces what it expresses.
   */
  base?: CollectionItem;
}

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** Single-line text: control characters (CR/LF included) become spaces. */
function oneLine(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return str(v, max * 2).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function pairs(list: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const p of list as RequestDraftPair[]) {
    if (!p || typeof p !== 'object') continue;
    const key = oneLine(p.key, 200);
    if (!key) continue;
    out.push({ key, value: oneLine(p.value, MAX_VALUE) });
    if (out.length >= MAX_PAIRS) break;
  }
  return out;
}

const encodeQueryPart = (s: string) => s.replace(/[&# ]/g, c => (c === '&' ? '%26' : c === '#' ? '%23' : '%20'));

const DANGEROUS_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'jar', 'view-source']);

/** `host:port` is not a scheme (`localhost:3000/x`); `javascript:1;alert(1)` and `data:1` are. Mirrors the server's sanitizeUrl. */
function hasForeignScheme(url: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!m || /^https?$/i.test(m[1])) return false;
  if (DANGEROUS_SCHEMES.has(m[1].toLowerCase())) return true;
  return !/^\d{1,5}(?:[/?#]|$)/.test(url.slice(m[0].length));
}

/**
 * Add a scheme to a bare host ("api.example.com/users" -> https://, "localhost:3000" -> http://).
 * Leaves `{{variable}}` prefixes, absolute URLs and path-only URLs alone.
 */
export function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  // `//host/x` and `\\host` name a host (protocol-relative): make the scheme explicit so the host is plain to see.
  if (/^[\\/]{2,}/.test(url)) url = `https://${url.replace(/^[\\/]+/, '')}`;
  // The URL parser reads `\` as `/` before the query: store what it will actually request (https://evil.test\@good.test).
  if (/^https?:\/\//i.test(url)) return url.replace(/^[^?#]*/, m => m.replace(/\\/g, '/'));
  if (url.startsWith('{{') || url.startsWith('/')) return url;
  if (hasForeignScheme(url)) return ''; // another scheme (javascript:, data:, file:, ...)
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url)) return `http://${url}`;
  return `https://${url}`;
}

function parseUrl(draftUrl: string, query: Array<{ key: string; value: string }>): CollectionUrl {
  const normalized = normalizeUrl(draftUrl);
  const hashAt = normalized.indexOf('#');
  const noHash = hashAt === -1 ? normalized : normalized.slice(0, hashAt);
  const qAt = noHash.indexOf('?');
  const base = qAt === -1 ? noHash : noHash.slice(0, qAt);
  const inlineQuery: CollectionQueryParam[] = [];
  if (qAt !== -1) {
    for (const part of noHash.slice(qAt + 1).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const key = eq === -1 ? part : part.slice(0, eq);
      if (key) inlineQuery.push({ key, value: eq === -1 ? '' : part.slice(eq + 1) });
    }
  }
  const allQuery: CollectionQueryParam[] = [...inlineQuery];
  for (const q of query) if (!allQuery.some(x => x.key === q.key && x.value === q.value)) allQuery.push({ key: q.key, value: q.value });

  const m = /^(?:(https?):\/\/)?([^/]*)(\/.*)?$/i.exec(base);
  const url: CollectionUrl = { raw: '' };
  if (m) {
    const [, protocol, hostPort, path] = m;
    if (protocol) url.protocol = protocol.toLowerCase();
    if (hostPort) {
      const portMatch = /^(.*):(\d{1,5})$/.exec(hostPort);
      const host = portMatch ? portMatch[1] : hostPort;
      if (portMatch) url.port = portMatch[2];
      // `{{baseUrl}}` stays one segment; real hostnames follow Postman's dot-split.
      url.host = host.includes('{{') ? [host] : host.split('.');
    }
    url.path = (path ?? '').split('/').filter(Boolean);
  }
  const qs = allQuery.map(q => `${encodeQueryPart(q.key)}=${encodeQueryPart(q.value)}`).join('&');
  url.raw = qs ? `${base}?${qs}` : base;
  if (allQuery.length) url.query = allQuery;
  return url;
}

function mapBody(body: RequestDraftBody | undefined): CollectionBody | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (body.mode === 'raw') {
    const raw = str(body.raw, MAX_RAW);
    if (!raw.trim()) return undefined;
    const language = ['json', 'text', 'xml', 'html', 'javascript'].includes(body.language as string) ? body.language! : 'json';
    return { mode: 'raw', raw, options: { raw: { language } } };
  }
  if (body.mode === 'formdata') {
    const rows = pairs(body.formdata);
    return rows.length ? { mode: 'formdata', formdata: rows.map(r => ({ key: r.key, value: r.value, type: 'text' })) } : undefined;
  }
  if (body.mode === 'urlencoded') {
    const rows = pairs(body.urlencoded);
    return rows.length ? { mode: 'urlencoded', urlencoded: rows } : undefined;
  }
  return undefined;
}

const VAR_REF_RE = /^\{\{[^{}\s]{1,100}\}\}$/;
/** Credentials may only be variable references: a literal value is dropped. */
const credential = (v: unknown) => { const s = oneLine(v, 500); return VAR_REF_RE.test(s) ? s : ''; };

function mapAuth(auth: RequestDraftAuth | undefined): CollectionAuth | undefined {
  if (!auth || typeof auth !== 'object') return undefined;
  const entry = (key: string, value: string) => ({ key, value, type: 'string' });
  switch (auth.type) {
    case 'noauth': return { type: 'noauth' };
    case 'bearer': return { type: 'bearer', bearer: [entry('token', credential(auth.token))] };
    case 'basic': return { type: 'basic', basic: [entry('username', credential(auth.username)), entry('password', credential(auth.password))] };
    case 'apikey': return {
      type: 'apikey',
      apikey: [entry('key', oneLine(auth.key, 100) || 'X-API-Key'), entry('value', credential(auth.value)), entry('in', auth.in === 'query' ? 'query' : 'header')],
    };
    default: return undefined; // 'inherit' and anything unknown: the request inherits by default
  }
}

function captureExpression(path: string): string {
  if (path.startsWith('header:')) return `apx.response.headers.get(${JSON.stringify(path.slice(7))})`;
  let expr = 'apx.response.json()';
  for (const m of path.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) expr += m[1] !== undefined ? `[${Number(m[1])}]` : `[${JSON.stringify(m[2])}]`;
  return expr;
}

/** The test script of the draft, plus a capture line for every variable it does not already set. */
export function draftTestScript(draft: Pick<RequestDraft, 'tests' | 'variablesToCapture'>): string {
  let tests = str(draft.tests, MAX_SCRIPT).trim();
  const seen = new Set<string>();
  for (const c of Array.isArray(draft.variablesToCapture) ? draft.variablesToCapture : []) {
    if (!c || typeof c.name !== 'string' || typeof c.path !== 'string') continue;
    if (!CAPTURE_NAME_RE.test(c.name) || !CAPTURE_PATH_RE.test(c.path) || seen.has(c.name)) continue;
    seen.add(c.name);
    const setsIt = new RegExp(`environment\\.set\\(\\s*["']${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(tests);
    if (!setsIt) tests += `${tests ? '\n' : ''}apx.environment.set(${JSON.stringify(c.name)}, ${captureExpression(c.path)});`;
  }
  return tests;
}

function scriptEvent(listen: CollectionEvent['listen'], code: string): CollectionEvent {
  return { listen, script: { type: 'text/javascript', exec: code.split(/\r?\n/) } };
}

type FormField = NonNullable<CollectionBody['formdata']>[number];

/**
 * What a draft cannot express but the request being modified has: disabled headers, file fields of a
 * form-data body and path-variable values. They are carried over unchanged (see `preservedNotes`).
 */
function keptFromBase(base: CollectionItem, header: CollectionHeader[], url: CollectionUrl) {
  const req = base.request;
  const taken = new Set(header.map(h => h.key.toLowerCase()));
  const headers = (req?.header ?? []).filter(h => h && h.disabled && h.key && !taken.has(h.key.toLowerCase()));
  const fileFields: FormField[] = (req?.body?.mode === 'formdata' ? req.body.formdata ?? [] : []).filter(f => f && f.type === 'file');
  const baseUrl = req?.url;
  const variables = (typeof baseUrl === 'object' && baseUrl?.variable ? baseUrl.variable : []).filter(v => v && v.key && new RegExp(`(?:^|/):${v.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?#]|$)`).test(url.raw));
  return { headers, fileFields, variables };
}

/** Human notes for the diff: what was carried over from `base` untouched. Empty for a new request. */
export function preservedNotes(base: CollectionItem | undefined, item: CollectionItem): string[] {
  if (!base) return [];
  const out: string[] = [];
  const baseHeaders = (base.request?.header ?? []).filter(h => h.disabled && h.key);
  const kept = baseHeaders.filter(h => (item.request?.header ?? []).some(x => x.disabled && x.key === h.key && x.value === h.value));
  if (kept.length) out.push(`${kept.length} disabled header${kept.length === 1 ? '' : 's'}`);
  const files = (base.request?.body?.mode === 'formdata' ? base.request.body.formdata ?? [] : []).filter(f => f.type === 'file');
  const keptFiles = files.filter(f => (item.request?.body?.formdata ?? []).some(x => x.type === 'file' && x.key === f.key));
  if (keptFiles.length) out.push(`${keptFiles.length} file field${keptFiles.length === 1 ? '' : 's'}`);
  const rowsOf = (it: CollectionItem | undefined) => [...(it?.request?.body?.formdata ?? []), ...(it?.request?.body?.urlencoded ?? [])];
  const keptRows = rowsOf(base).filter(r => r.disabled && r.key && rowsOf(item).some(x => x.disabled && x.key === r.key));
  if (keptRows.length) out.push(`${keptRows.length} disabled body row${keptRows.length === 1 ? '' : 's'}`);
  if (base.request?.body?.mode === 'file' && item.request?.body?.mode === 'file') out.push('the attached file body');
  const u = item.request?.url;
  const vars = typeof u === 'object' && u?.variable ? u.variable.length : 0;
  if (vars) out.push(`${vars} path variable${vars === 1 ? '' : 's'}`);
  return out;
}

export function draftToItem(draft: RequestDraft, options: DraftToItemOptions = {}): CollectionItem {
  const d: Partial<RequestDraft> = draft && typeof draft === 'object' ? draft : {};
  const base = options.base;
  const method = typeof d.method === 'string' && METHODS.includes(d.method.toUpperCase()) ? d.method.toUpperCase() : 'GET';
  const header: CollectionHeader[] = pairs(d.headers).map(h => ({ key: h.key, value: h.value }));
  const url = parseUrl(oneLine(d.url, MAX_URL), pairs(d.query));
  const kept = base ? keptFromBase(base, header, url) : null;
  if (kept) { header.push(...kept.headers); if (kept.variables.length) url.variable = kept.variables; }

  const request: CollectionRequest = { method, url, header };
  let body = mapBody(d.body);
  if (kept && body?.mode === 'formdata' && kept.fileFields.length) body = { ...body, formdata: [...(body.formdata ?? []), ...kept.fileFields] };
  if (kept && body && (body.mode === 'formdata' || body.mode === 'urlencoded') && base?.request?.body?.mode === body.mode) {
    // Disabled rows are the user's own notes: a draft cannot express them, so they stay.
    const mine = (body.mode === 'formdata' ? body.formdata : body.urlencoded) ?? [];
    const old = (body.mode === 'formdata' ? base.request.body.formdata : base.request.body.urlencoded) ?? [];
    const disabled = old.filter(r => r && r.disabled && r.key && !mine.some(x => x.key === r.key));
    if (disabled.length) body = body.mode === 'formdata' ? { ...body, formdata: [...mine, ...disabled] as NonNullable<CollectionBody['formdata']> } : { ...body, urlencoded: [...mine, ...disabled] };
  }
  // A body the draft format cannot express (a binary file) is not silently dropped when the draft has no body.
  if (!body && base?.request?.body && base.request.body.mode === 'file') body = base.request.body;
  if (body) request.body = body;
  const auth = mapAuth(d.auth) ?? (base?.request?.auth && base.request.auth.type !== 'inherit' ? base.request.auth : undefined);
  if (auth) request.auth = auth;
  if (base?.request?.description) request.description = base.request.description;
  if (base?.request?.requestSettings) request.requestSettings = base.request.requestSettings;

  const event: CollectionEvent[] = [];
  const pre = str(d.preRequest, MAX_SCRIPT).trim();
  if (pre) event.push(scriptEvent('prerequest', pre));
  const tests = draftTestScript(d);
  if (tests) event.push(scriptEvent('test', tests));

  const item: CollectionItem = {
    id: options.id ?? base?.id ?? newId(),
    name: oneLine(d.name, MAX_NAME) || base?.name || 'New request',
    request,
  };
  if (event.length) item.event = event;
  if (base?.description) item.description = base.description;
  if (base?.response) item.response = base.response;
  return item;
}
