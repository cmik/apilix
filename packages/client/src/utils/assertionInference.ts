/**
 * Deterministic assertion suggestions from a live HTTP response. No network, no AI:
 * the same input always yields the same suggestions. An AI layer can later refine them.
 *
 * Design rules:
 *  - never assert a concrete value of a volatile field (ids, timestamps, tokens…): types/formats only;
 *  - every generated script uses the `apx.*` API and passes on the response it was inferred from;
 *  - output is bounded (depth, fields per object, total) so a huge payload stays reviewable.
 */

import { buildJsonAccessExpression } from './testSnippetUtils';

export type SuggestionKind = 'status' | 'header' | 'body' | 'schema' | 'timing' | 'capture';
export type SuggestionConfidence = 'high' | 'medium' | 'low';

export interface AssertionSuggestion {
  /** Stable within one response. */
  id: string;
  /** Test name (also used to detect an already present test). */
  title: string;
  kind: SuggestionKind;
  /** `apx.*` code ready to append to the test script. */
  script: string;
  confidence: SuggestionConfidence;
  /** The checked value may change between runs; only shape/format is asserted. */
  volatile?: boolean;
  /** Pre-checked in the UI. */
  recommended: boolean;
}

export interface InferenceInput {
  status: number;
  headers: Record<string, string>;
  body: string;
  responseTime?: number;
  /** Non-text payload: body inference is skipped. */
  bodyBase64?: string;
}

const MAX_BODY_CHARS = 1_000_000;
const MAX_DEPTH = 3;
const MAX_KEYS_PER_OBJECT = 15;
const MAX_FORMAT_SUGGESTIONS = 12;
const MAX_CAPTURES = 6;

type Path = (string | number)[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

const FORMATS: { name: string; re: RegExp; source: string; label: string }[] = [
  { name: 'uuid', re: UUID_RE, source: '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', label: 'a UUID' },
  { name: 'iso-date', re: ISO_DATE_RE, source: '/^\\d{4}-\\d{2}-\\d{2}/', label: 'an ISO date' },
  { name: 'email', re: EMAIL_RE, source: '/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/', label: 'an email address' },
  { name: 'url', re: URL_RE, source: '/^https?:\\/\\//i', label: 'a URL' },
];

// snake/kebab/plain names (case-insensitive) and camelCase suffixes (case-sensitive, so "valid" is not "…Id").
const VOLATILE_SNAKE_RE = /(^|[_-])(id|uuid|guid|token|jwt|nonce|etag|hash|signature)$|(created|updated|modified|deleted|expires?|issued|timestamp|date)(_?at)?$|(^|[_-])(at|time)$/i;
const VOLATILE_CAMEL_RE = /[a-z](Id|Uuid|Token|Hash|At|Time|Date)$/;
const STABLE_ENUM_KEYS = new Set(['status', 'state', 'type', 'kind', 'role', 'currency', 'locale', 'language', 'object']);
const CAPTURE_KEY_RE = /^(id|uuid|token|access_?token|refresh_?token|id_?token|jwt|session_?id|api_?key)$|(_id|Id)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isVolatileKey(key: string): boolean {
  return VOLATILE_SNAKE_RE.test(key) || VOLATILE_CAMEL_RE.test(key);
}

function typeOf(v: unknown): 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'other' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'other';
  }
}

function pathLabel(path: Path): string {
  if (path.length === 0) return 'response';
  return path.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc || 'response'}[${seg}]`;
    return acc ? `${acc}.${seg}` : seg;
  }, '');
}

function testBlock(title: string, lines: string[]): string {
  return `apx.test(${JSON.stringify(title)}, () => {\n${lines.map(l => `  ${l}`).join('\n')}\n});`;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : undefined;
}

/** Round an observed duration up to a generous, human-looking budget. */
function timingBudget(ms: number): number {
  const target = Math.max(ms * 4, 300);
  for (const step of [300, 500, 1000, 2000, 3000, 5000, 10000, 30000]) if (target <= step) return step;
  return Math.ceil(target / 10000) * 10000;
}

function varNameFor(path: Path): string {
  const parts = path.filter((p): p is string => typeof p === 'string');
  const last = parts[parts.length - 1] ?? 'value';
  const camel = last.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''));
  return camel || 'value';
}

/** Suggest assertions for a response. Never throws. */
export function inferAssertions(input: InferenceInput): AssertionSuggestion[] {
  const out: AssertionSuggestion[] = [];
  let seq = 0;
  const add = (s: Omit<AssertionSuggestion, 'id'>) => out.push({ id: `s${++seq}`, ...s });

  // ── status ────────────────────────────────────────────────────────────────
  if (Number.isInteger(input.status) && input.status > 0) {
    const title = `Status code is ${input.status}`;
    add({ title, kind: 'status', confidence: 'high', recommended: true, script: testBlock(title, [`apx.expect(apx.response.code).to.equal(${input.status});`]) });
  }

  // ── content type ──────────────────────────────────────────────────────────
  const ctRaw = headerValue(input.headers, 'content-type');
  if (ctRaw) {
    const media = ctRaw.split(';')[0].trim();
    if (media) {
      const title = `Content-Type is ${media}`;
      add({ title, kind: 'header', confidence: 'high', recommended: true, script: testBlock(title, [`apx.expect(apx.response.headers.get('Content-Type')).to.include(${JSON.stringify(media)});`]) });
    }
  }

  // ── timing ────────────────────────────────────────────────────────────────
  if (typeof input.responseTime === 'number' && input.responseTime >= 0) {
    const budget = timingBudget(input.responseTime);
    const title = `Response time is below ${budget} ms`;
    add({ title, kind: 'timing', confidence: 'low', volatile: true, recommended: false, script: testBlock(title, [`apx.expect(apx.response.responseTime).to.be.below(${budget});`]) });
  }

  // ── body ──────────────────────────────────────────────────────────────────
  if (input.bodyBase64 || typeof input.body !== 'string' || !input.body.trim() || input.body.length > MAX_BODY_CHARS) return out;

  let json: unknown;
  try { json = JSON.parse(input.body); } catch {
    const title = 'Body is not empty';
    add({ title, kind: 'body', confidence: 'medium', recommended: false, script: testBlock(title, ['apx.expect(apx.response.text()).to.not.be.empty;']) });
    return out;
  }

  let formatCount = 0;
  let captureCount = 0;
  const seenCaptureVars = new Set<string>();

  const walkObject = (obj: Record<string, unknown>, path: Path, depth: number) => {
    const keys = Object.keys(obj).slice(0, MAX_KEYS_PER_OBJECT);
    const lines: string[] = [];
    const nested: { key: string; value: unknown }[] = [];
    for (const key of keys) {
      const value = obj[key];
      const t = typeOf(value);
      const fieldPath = [...path, key];
      const access = buildJsonAccessExpression(fieldPath);
      if (t === 'string' || t === 'number' || t === 'boolean') {
        lines.push(`apx.expect(${access}).to.be.a('${t}');`);
      } else if (t === 'array') {
        lines.push(`apx.expect(${access}).to.be.an('array');`);
        nested.push({ key, value });
      } else if (t === 'object') {
        lines.push(`apx.expect(${access}).to.be.an('object');`);
        nested.push({ key, value });
      } else if (t === 'null') {
        // A null field says nothing about its usual type: assert nothing about it.
      }

      if (t === 'string') {
        const s = value as string;
        const fmt = FORMATS.find(f => f.re.test(s));
        if (fmt && formatCount < MAX_FORMAT_SUGGESTIONS) {
          formatCount++;
          const title = `${pathLabel(fieldPath)} is ${fmt.label}`;
          add({
            title, kind: 'body', confidence: 'medium', volatile: isVolatileKey(key), recommended: true,
            script: testBlock(title, [`apx.expect(${access}).to.match(${fmt.source});`]),
          });
        } else if (!fmt && STABLE_ENUM_KEYS.has(key) && s.length > 0 && s.length <= 24 && !isVolatileKey(key)) {
          const title = `${pathLabel(fieldPath)} equals ${s}`;
          add({ title, kind: 'body', confidence: 'medium', recommended: false, script: testBlock(title, [`apx.expect(${access}).to.equal(${JSON.stringify(s)});`]) });
        }
      }

      if ((t === 'string' || t === 'number') && CAPTURE_KEY_RE.test(key) && depth <= 2 && captureCount < MAX_CAPTURES) {
        const varName = varNameFor(fieldPath);
        if (!seenCaptureVars.has(varName)) {
          seenCaptureVars.add(varName);
          captureCount++;
          const title = `Save ${pathLabel(fieldPath)} as ${varName}`;
          add({ title, kind: 'capture', confidence: 'medium', volatile: true, recommended: false, script: `apx.environment.set(${JSON.stringify(varName)}, ${access});` });
        }
      }
    }
    if (lines.length) {
      const title = `${pathLabel(path)} has the expected fields`;
      add({ title, kind: 'schema', confidence: 'high', recommended: true, script: testBlock(title, lines) });
    }
    if (depth < MAX_DEPTH) {
      for (const n of nested) walkValue(n.value, [...path, n.key], depth + 1);
    }
  };

  const walkValue = (value: unknown, path: Path, depth: number) => {
    if (Array.isArray(value)) {
      if (path.length > 0) {
        const title = `${pathLabel(path)} is not empty`;
        if (value.length > 0) {
          add({ title, kind: 'body', confidence: 'medium', volatile: true, recommended: false, script: testBlock(title, [`apx.expect(${buildJsonAccessExpression(path)}).to.not.be.empty;`]) });
        }
      }
      // Items of an array share a shape: describe the first one.
      if (value.length > 0 && isPlainObject(value[0]) && depth <= MAX_DEPTH) walkObject(value[0], [...path, 0], depth);
    } else if (isPlainObject(value)) {
      walkObject(value, path, depth);
    }
  };

  if (Array.isArray(json)) {
    const title = 'Response is a non-empty array';
    if (json.length > 0) {
      add({ title, kind: 'body', confidence: 'medium', volatile: true, recommended: false, script: testBlock(title, ["apx.expect(apx.response.json()).to.be.an('array');", 'apx.expect(apx.response.json()).to.not.be.empty;']) });
    } else {
      add({ title: 'Response is an array', kind: 'body', confidence: 'high', recommended: true, script: testBlock('Response is an array', ["apx.expect(apx.response.json()).to.be.an('array');"]) });
    }
    walkValue(json, [], 1);
  } else if (isPlainObject(json)) {
    walkObject(json, [], 1);
  }
  return out;
}

/**
 * Substrings that, when found in a test script, mean the suggestion is already there:
 * its exact code, or (for tests) a test with the same name written with either quote style.
 */
export function presenceNeedles(suggestion: Pick<AssertionSuggestion, 'script' | 'title' | 'kind'>): string[] {
  const needles = [suggestion.script.trim()];
  if (suggestion.kind !== 'capture') {
    needles.push(`apx.test(${JSON.stringify(suggestion.title)}`);
    needles.push(`apx.test('${suggestion.title.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
  }
  return needles;
}

/** True when the script already contains this suggestion. */
export function isSuggestionPresent(script: string, suggestion: Pick<AssertionSuggestion, 'script' | 'title' | 'kind'>): boolean {
  if (!script) return false;
  return presenceNeedles(suggestion).some(n => script.includes(n));
}
