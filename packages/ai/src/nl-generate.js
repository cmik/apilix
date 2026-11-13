'use strict';

/**
 * Natural-language request generation.
 *
 * The user's sentence is trusted input; everything taken from the collection (neighbouring requests,
 * the request being modified, variable names) is untrusted data (wrapUntrusted) and redacted first.
 * The model's draft is schema-checked, sanitised field by field, and its scripts are dry-run in the
 * child-process sandbox (one retry with the error, then the proposal is returned marked "not validated").
 * A script refused by the security screen is dropped from the draft and reported in `validation.removed`.
 * Nothing is applied here: the client shows the draft and the user decides.
 */

const { neutralizeAiText } = require('@apilix/core/docs');
const { AiError } = require('./errors');
const { estimateTokens } = require('./budget');
const { redactRequest, redactScript, scrubSecretValues, scrubTokenPatterns } = require('./redact');
const { getPrompt, stripDelimiters } = require('./prompts');
const { dryRunScript } = require('./dry-run');
const { validateOutput } = require('./validate');

const MAX_INSTRUCTION_CHARS = 1000;
const MAX_VARIABLES = 200;
const MAX_NEIGHBORS = 5;
const MAX_NAME_CHARS = 200;
const MAX_URL_CHARS = 2000;
const MAX_VALUE_CHARS = 2000;
const MAX_SCRIPT_CHARS = 6000;
const MAX_PAIRS = 30;
const OUTPUT_RESERVE_TOKENS = 3000;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;
const CAPTURE_PATH_RE = /^(?:header:[A-Za-z0-9-]{1,80}|[A-Za-z_$][\w$-]{0,60}(?:\.[\w$-]{1,60}|\[\d{1,3}\]){0,8})$/;
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token', 'x-access-token']);
const VAR_REF_RE = /^\{\{[^{}\s]{1,100}\}\}$/;
// Names that carry a credential in a header, a query parameter or a body field (X-Secret, X-Custom-Token, api_key, client_secret...).
const SENSITIVE_NAME_RE = /(?:passw(?:or)?d|passwd|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|signature|authorization)|^(?:key|auth|sig)$|[_-](?:key|auth)$/i;
const NOT_A_SECRET_VALUE_RE = /^(?:\d+(?:\.\d+)?|true|false|null)$/i;
const DANGEROUS_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'jar', 'view-source']);

function clip(v, max) {
  const s = v === undefined || v === null ? '' : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
// Control characters (CR/LF included) never belong in a header, URL or name.
const oneLine = (v, max) => clip(String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), max);

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return neutralizeAiText(v).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS);
}

function execText(exec) {
  return Array.isArray(exec) ? exec.join('\n') : typeof exec === 'string' ? exec : '';
}

function itemScripts(item) {
  const out = {};
  for (const ev of (item && item.event) || []) {
    const text = execText(ev && ev.script && ev.script.exec);
    if (text.trim()) out[ev.listen === 'test' ? 'tests' : 'preRequest'] = text;
  }
  return out;
}

function urlOf(request) {
  const u = request && request.url;
  return typeof u === 'string' ? u : (u && u.raw) || '';
}

/** One request, redacted and bounded, in the shape the prompt describes. */
function describeItem(item, { secretValues, redactSecrets, bodyChars, scriptChars }) {
  const request = (item && item.request) || {};
  const red = redactRequest(request, { secretValues, redactSecrets });
  const scripts = itemScripts(item);
  const out = { name: oneLine(item && item.name, MAX_NAME_CHARS), method: red.method, url: oneLine(red.url, 300) };
  if (Array.isArray(red.header)) {
    const headers = red.header.filter(h => h && h.key && !h.disabled).slice(0, 15).map(h => ({ key: oneLine(h.key, 100), value: oneLine(h.value, 120) }));
    if (headers.length) out.headers = headers;
  }
  const b = red.body;
  if (b && b.mode === 'raw' && typeof b.raw === 'string' && b.raw) out.body = { mode: 'raw', raw: clip(b.raw, bodyChars) };
  else if (b && (b.mode === 'formdata' || b.mode === 'urlencoded')) {
    out.body = { mode: b.mode, fields: (b[b.mode] || []).slice(0, 20).map(p => oneLine(p.key, 100)) };
  }
  if (request.auth && request.auth.type) out.authType = request.auth.type;
  for (const [k, v] of Object.entries(scripts)) {
    out[k] = clip(redactSecrets !== false ? redactScript(v) : v, scriptChars);
  }
  return out;
}

function cleanVariables(variables) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(variables) ? variables : []) {
    if (!v || typeof v.name !== 'string' || !v.name.trim()) continue;
    const name = oneLine(v.name, 80);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, scope: typeof v.scope === 'string' ? oneLine(v.scope, 20) : undefined, secret: v.secret === true });
    if (out.length >= MAX_VARIABLES) break;
  }
  return out;
}

function buildContext({ variables, neighbors, current, secretValues, redactSecrets, neighborCount, trim }) {
  const data = {
    variables: variables.map(v => `${v.scope ? `${v.scope}: ` : ''}${v.name}${v.secret ? ' (secret)' : ''}`),
    ...(variables.some(v => v.name === 'baseUrl') ? { baseUrlVariable: '{{baseUrl}}' } : {}),
  };
  if (neighborCount > 0 && neighbors.length) {
    data.exampleRequests = neighbors.slice(0, neighborCount).map(n => describeItem(n, { secretValues, redactSecrets, bodyChars: trim ? 150 : 400, scriptChars: trim ? 200 : 600 }));
  }
  if (current) data.currentRequest = describeItem(current, { secretValues, redactSecrets, bodyChars: trim ? 1500 : 4000, scriptChars: trim ? 1500 : 4000 });
  let text = JSON.stringify(data, null, 1);
  if (redactSecrets !== false) text = scrubTokenPatterns(text);
  return scrubSecretValues(text, secretValues);
}

/** Shrink the context (fewer examples, shorter fields) until the real prompt fits. */
function fitPrompt(args, language, maxContextTokens) {
  const steps = [];
  for (let n = MAX_NEIGHBORS; n >= 0; n--) steps.push({ neighborCount: n, trim: false });
  steps.push({ neighborCount: 0, trim: true });
  for (const step of steps) {
    const data = buildContext({ ...args, ...step });
    const prompt = getPrompt('nlGenerate', { language, data, instruction: args.instruction });
    const cost = estimateTokens(prompt.system) + estimateTokens(prompt.user) + Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(maxContextTokens * 0.35));
    if (cost <= maxContextTokens) return { prompt, cost, neighbors: step.neighborCount };
  }
  throw new AiError('TOO_LARGE', 'The instruction and context are too large for the configured context limit');
}

/** A literal value under a credential-looking name is dropped: a model must only reference variables. */
function guardLiteral(name, value, where, warnings) {
  if (!value || !SENSITIVE_NAME_RE.test(name) || NOT_A_SECRET_VALUE_RE.test(value)) return value;
  if (/^(?:Bearer |Basic |Token )?\{\{[^{}\s]{1,100}\}\}$/.test(value)) return value;
  warnings.push(`The value of the "${clip(name, 40)}" ${where} was left empty: a model must not provide credentials.`);
  return '';
}

function sanitizePairs(list, { credentialGuard, guard, warnings }) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p.key !== 'string') continue;
    const key = oneLine(p.key, 200);
    if (!key) continue;
    let value = oneLine(p.value, MAX_VALUE_CHARS);
    if (credentialGuard) {
      if (!HEADER_NAME_RE.test(key)) { warnings.push(`Dropped header with an invalid name "${clip(key, 40)}".`); continue; }
      if (CREDENTIAL_HEADERS.has(key.toLowerCase()) && value && !/^(?:Bearer |Basic |Token )?\{\{[^{}\s]{1,100}\}\}$/.test(value)) {
        warnings.push(`The value of the "${key}" header was left empty: a model must not provide credentials.`);
        value = '';
      } else {
        value = guardLiteral(key, value, 'header', warnings);
      }
    } else if (guard) {
      value = guardLiteral(key, value, guard, warnings);
    }
    out.push({ key, value });
    if (out.length >= MAX_PAIRS) break;
  }
  return out;
}

function sanitizeAuth(auth, warnings) {
  if (!auth || typeof auth !== 'object') return undefined;
  const ref = (v, label) => {
    const s = oneLine(v, 500);
    if (!s) return '';
    if (VAR_REF_RE.test(s)) return s;
    warnings.push(`The auth ${label} was left empty: use a {{variable}} instead of a literal credential.`);
    return '';
  };
  switch (auth.type) {
    case 'noauth': case 'inherit': return { type: auth.type };
    case 'bearer': return { type: 'bearer', token: ref(auth.token, 'token') };
    case 'basic': return { type: 'basic', username: ref(auth.username, 'username'), password: ref(auth.password, 'password') };
    case 'apikey': {
      const key = oneLine(auth.key, 100);
      return { type: 'apikey', key: HEADER_NAME_RE.test(key) ? key : 'X-API-Key', value: ref(auth.value, 'value'), in: auth.in === 'query' ? 'query' : 'header' };
    }
    default: return undefined;
  }
}

/** Blank literal credentials in a raw body: JSON ("password": "x") and form-style (password=x) pairs. */
function guardRawBody(raw, warnings) {
  const json = /("(?:[^"\\\n]|\\.){1,100}"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
  let out = raw.replace(json, (m, head, val) => {
    const name = head.replace(/\s*:\s*$/, '').slice(1, -1);
    return guardLiteral(name, val, 'body field', warnings) === val ? m : `${head}""`;
  });
  if (!/^\s*[[{<]/.test(out)) {
    out = out.replace(/(^|&)([A-Za-z0-9_.-]{1,100})=([^&\n]*)/g, (m, amp, name, val) => (guardLiteral(name, val, 'body field', warnings) === val ? m : `${amp}${name}=`));
  }
  return out;
}

function sanitizeBody(body, warnings) {
  if (!body || typeof body !== 'object') return { mode: 'none' };
  switch (body.mode) {
    case 'raw': {
      const raw = typeof body.raw === 'string' ? body.raw.slice(0, 20000) : '';
      if (!raw) return { mode: 'none' };
      return { mode: 'raw', raw: guardRawBody(raw, warnings), language: ['json', 'text', 'xml', 'html', 'javascript'].includes(body.language) ? body.language : 'json' };
    }
    case 'formdata': return { mode: 'formdata', formdata: sanitizePairs(body.formdata, { guard: 'body field', warnings }) };
    case 'urlencoded': return { mode: 'urlencoded', urlencoded: sanitizePairs(body.urlencoded, { guard: 'body field', warnings }) };
    default: return { mode: 'none' };
  }
}

/** Same rule as the client (utils/ai/draftToItem.ts): `host:port` is not a scheme, `javascript:`/`data:`/`file:` are. */
function hasForeignScheme(u) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  if (!m || /^https?$/i.test(m[1])) return false;
  if (DANGEROUS_SCHEMES.has(m[1].toLowerCase())) return true;
  return !/^\d{1,5}(?:[/?#]|$)/.test(u.slice(m[0].length)); // `localhost:3000/x`, `api.example.com:8080` are host:port
}

/** `https://user:secret@host/x`: a literal credential in the URL authority is dropped (`{{variables}}` are kept). */
function stripLiteralUserInfo(u, warnings) {
  const m = /^((?:[a-z][a-z0-9+.-]*:)?[\\/]{0,2})([^/\\?#]*)/i.exec(u);
  if (!m || !m[2].includes('@')) return u;
  const at = m[2].lastIndexOf('@');
  const userInfo = m[2].slice(0, at);
  if (!userInfo.replace(/\{\{[^{}\s]{1,100}\}\}/g, '').replace(/[:]/g, '')) return u;
  warnings.push('A literal credential in the URL (user:password@host) was removed: use a {{variable}} and the auth settings.');
  return `${m[1]}${m[2].slice(at + 1)}${u.slice(m[0].length)}`;
}

function sanitizeUrl(url, warnings) {
  let u = oneLine(url, MAX_URL_CHARS);
  if (hasForeignScheme(u)) {
    warnings.push('The URL used an unsupported scheme and was cleared.');
    return '';
  }
  u = stripLiteralUserInfo(u, warnings);
  const q = u.indexOf('?');
  if (q !== -1) {
    const hash = u.indexOf('#', q);
    const query = u.slice(q + 1, hash === -1 ? undefined : hash);
    const guarded = query.split('&').map((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return part;
      const name = part.slice(0, eq);
      return `${name}=${guardLiteral(name, part.slice(eq + 1), 'query parameter', warnings)}`;
    }).join('&');
    u = `${u.slice(0, q + 1)}${guarded}${hash === -1 ? '' : u.slice(hash)}`;
  }
  return u;
}

function script(v, max = MAX_SCRIPT_CHARS) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Dot-path -> JS expression over the response, built from validated segments only. */
function captureExpression(pathStr) {
  if (pathStr.startsWith('header:')) return `apx.response.headers.get(${JSON.stringify(pathStr.slice(7))})`;
  let expr = 'apx.response.json()';
  for (const m of pathStr.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    expr += m[1] !== undefined ? `[${Number(m[1])}]` : `[${JSON.stringify(m[2])}]`;
  }
  return expr;
}

/** Normalise the model's draft. Unknown fields vanish; every string is bounded and cleaned. */
function sanitizeDraft(data, warnings) {
  const d = data && typeof data === 'object' ? data : {};
  const captures = [];
  for (const c of Array.isArray(d.variablesToCapture) ? d.variablesToCapture : []) {
    if (!c || typeof c.name !== 'string' || typeof c.path !== 'string') continue;
    if (!VAR_NAME_RE.test(c.name) || !CAPTURE_PATH_RE.test(c.path)) { warnings.push(`Ignored a variable to capture with an invalid name or path.`); continue; }
    if (!captures.some(x => x.name === c.name)) captures.push({ name: c.name, path: c.path });
    if (captures.length >= 10) break;
  }
  const auth = sanitizeAuth(d.auth, warnings);
  let tests = script(d.tests);
  for (const c of captures) {
    if (!new RegExp(String.raw`environment\.set\(\s*["']${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(tests)) {
      tests += `${tests ? '\n' : ''}apx.environment.set(${JSON.stringify(c.name)}, ${captureExpression(c.path)});`;
    }
  }
  const pre = script(d.preRequest, 4000);
  return {
    name: cleanName(d.name) || 'Generated request',
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(d.method) ? d.method : 'GET',
    url: sanitizeUrl(d.url, warnings),
    headers: sanitizePairs(d.headers, { credentialGuard: true, warnings }),
    query: sanitizePairs(d.query, { guard: 'query parameter', warnings }),
    body: sanitizeBody(d.body, warnings),
    ...(auth ? { auth } : {}),
    tests,
    ...(pre ? { preRequest: pre } : {}),
    variablesToCapture: captures,
  };
}

function standInResponse(tests) {
  const m = /(?:code|status)[^;\n]{0,40}?\b([1-5]\d\d)\b/.exec(tests || '');
  return { status: m ? Number(m[1]) : 200, statusText: '', headers: { 'content-type': 'application/json' }, body: '{}', responseTime: 100 };
}

/**
 * Dry-run the scripts of a draft. `errors` is the list of problems; a problem flagged `refused` means the
 * security screen rejected the script: it was never executed and must not be offered. `notExecuted` counts
 * the scripts that only got the screen + a syntax check (parse-only mode): they are reported, not "validated".
 */
async function validateScripts(draft) {
  const errors = [];
  let notExecuted = 0;
  const response = standInResponse(draft.tests);
  for (const field of ['tests', 'preRequest']) {
    const code = draft[field];
    if (!code) continue;
    const v = await dryRunScript(code, { response, mode: 'lenient' });
    if (!v.ok) errors.push({ field, reason: oneLine(neutralizeAiText(v.reason || 'failed'), 240), ...(v.screened === false ? { refused: true } : {}), ...(v.infra ? { infra: true } : {}) });
    else if (v.executed === false) notExecuted++;
  }
  errors.notExecuted = notExecuted;
  return errors;
}

/**
 * @param {{ provider: { complete: Function }, instruction: string, current?: object, neighbors?: object[],
 *   variables?: Array<{name:string, scope?:string, secret?:boolean}>, maxContextTokens?: number,
 *   redactSecrets?: boolean, secretValues?: string[], language?: string, signal?: AbortSignal }} input
 * @returns {Promise<{ draft: object, validation: { validated: boolean, executed: boolean, errors: Array<{field:string, reason:string}> },
 *   warnings: string[], usage: {inputTokens:number, outputTokens:number}, retried: boolean }>}
 */
async function generateRequest(input) {
  const { provider, current, secretValues, language, signal } = input;
  const maxContextTokens = input.maxContextTokens > 0 ? input.maxContextTokens : 8000;
  const redactSecrets = input.redactSecrets !== false;
  let instruction = stripDelimiters(String(input.instruction || '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (redactSecrets) instruction = scrubTokenPatterns(instruction);
  instruction = scrubSecretValues(instruction, secretValues).slice(0, MAX_INSTRUCTION_CHARS);
  if (!instruction) throw Object.assign(new Error('instruction is required'), { code: 'BAD_REQUEST' });

  const variables = cleanVariables(input.variables);
  const neighbors = (Array.isArray(input.neighbors) ? input.neighbors : []).filter(n => n && typeof n === 'object' && n.request).slice(0, MAX_NEIGHBORS);
  const { prompt } = fitPrompt({ instruction, variables, neighbors, current, secretValues, redactSecrets }, language, maxContextTokens);

  const usage = { inputTokens: 0, outputTokens: 0 };
  const warnings = [];
  const ask = async (messages) => {
    const r = await provider.complete({ system: prompt.system, messages, schema: 'requestDraft', signal, maxTokens: OUTPUT_RESERVE_TOKENS });
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    return r;
  };

  const first = await ask([{ role: 'user', content: prompt.user }]);
  let draft = sanitizeDraft(first.data, warnings);
  let errors = await validateScripts(draft);
  let notExecuted = errors.notExecuted;
  let retried = false;

  // A problem that is not about the script (busy, cancelled, unavailable) is not something the model can fix.
  if (errors.some(e => !e.infra)) {
    retried = true;
    const problems = errors.map(e => `${e.field}: ${e.reason}`).join('; ');
    try {
      const second = await ask([
        { role: 'user', content: prompt.user },
        { role: 'assistant', content: JSON.stringify(first.data) },
        { role: 'user', content: `Your scripts failed validation (${problems}). Return the complete corrected request. Use only the documented apx API.` },
      ]);
      const retryWarnings = [];
      const retryDraft = sanitizeDraft(second.data, retryWarnings);
      const retryErrors = await validateScripts(retryDraft);
      draft = retryDraft;
      errors = retryErrors;
      notExecuted = retryErrors.notExecuted;
      warnings.length = 0;
      warnings.push(...retryWarnings);
    } catch (err) {
      if (err instanceof AiError && (err.code === 'ABORTED' || err.code === 'AUTH' || err.code === 'RATE_LIMIT')) throw err;
      // The retry is best effort: keep the first draft, flagged as not validated.
    }
  }

  // A script the security screen refused is removed from the draft: it is never shown as applicable.
  const removed = [];
  for (const e of errors.filter(x => x.refused)) {
    draft[e.field] = '';
    removed.push({ field: e.field, reason: e.reason });
    warnings.push(`The ${e.field === 'tests' ? 'test' : 'pre-request'} script was refused for security reasons and removed from the proposal.`);
  }
  errors = errors.filter(x => !x.refused);
  if (notExecuted > 0) warnings.push('The scripts were NOT executed: this build cannot run them in an isolated process. They passed the security screen and a syntax check only.');

  const check = validateOutput('requestDraft', { ...draft, auth: draft.auth, preRequest: draft.preRequest });
  if (!check.ok) throw new AiError('INVALID_OUTPUT', `The generated request is not valid (${check.formatted})`);
  return { draft, validation: { validated: errors.length === 0 && notExecuted === 0, executed: notExecuted === 0, errors, removed }, warnings: [...new Set(warnings)].slice(0, 10), usage, retried };
}

module.exports = { generateRequest, sanitizeDraft, validateScripts, captureExpression, describeItem, fitPrompt };
