'use strict';

/**
 * Ask the model why one request's assertions failed. TEXT ONLY: the answer is shown to the user and
 * never applied or executed here.
 *
 * Trust model: the request, the response, the failure messages and the test script are untrusted data
 * (wrapUntrusted). They are redacted like every other AI feature (names, token patterns, every known
 * secret value including its base64 / URL-encoded forms) before they leave. What comes back is untrusted
 * too: schema-checked, bounded, neutralised (no links, images or HTML) and re-scrubbed of secret values.
 */

const { neutralizeAiText } = require('@apilix/core/docs');
const { AiError } = require('./errors');
const { estimateTokens, truncateText, truncateJson } = require('./budget');
const { redactRequest, redactResponse, redactScript, scrubSecretValues, scrubTokenPatterns } = require('./redact');
const { buildShapeSchema } = require('./context');
const { getPrompt } = require('./prompts');
const { clip, trimHeaders, trimRequest, normalizeLatency } = require('./assert-suggest');

const CONFIDENCES = ['low', 'medium', 'high'];
const FIX_KINDS = ['assertion', 'request', 'environment', 'other'];
const MAX_CAUSES = 4;
const MAX_FIXES = 4;
const MAX_SUMMARY_CHARS = 600;
const MAX_TEXT_CHARS = 400;
const MAX_SNIPPET_CHARS = 1500;
const MAX_FAILURES = 20;
const MAX_FAILURE_NAME_CHARS = 200;
const MAX_FAILURE_ERROR_CHARS = 600;
const MAX_SCRIPT_CHARS = 3000;
const MAX_VARIABLE_NAMES = 100;
const MAX_VARIABLE_NAME_CHARS = 100;
const OUTPUT_RESERVE_TOKENS = 1500;
const MIN_BODY_TOKENS = 50;
const MAX_MASK_INPUT_CHARS = 4000;

function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

/**
 * Shape-only mode: an assertion error can carry real response values (`expected 'a@b.c' to equal 'x'`).
 * Quoted strings and numbers become placeholders; the assertion kind stays readable. A quote that is
 * never closed hides everything after it, so a stray apostrophe cannot let a value through.
 */
function maskLiterals(text) {
  if (typeof text !== 'string') return '';
  // Single linear pass over a bounded input: no regex backtracking on attacker-shaped text.
  const src = text.length > MAX_MASK_INPUT_CHARS ? text.slice(0, MAX_MASK_INPUT_CHARS) : text;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch !== "'" && ch !== '"' && ch !== '`') { out += ch; i++; continue; }
    let j = i + 1;
    let closed = false;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === ch) { closed = true; break; }
      j++;
    }
    out += '<string>';
    if (!closed) break; // unclosed quote: everything after it is hidden
    i = j + 1;
  }
  // Emails: a whitespace-delimited token with an '@' that has a character on both sides.
  out = out.split(/(\s+)/).map(tok => {
    const at = tok.indexOf('@', 1);
    return at !== -1 && at < tok.length - 1 && !/^\s/.test(tok) ? '<string>' : tok;
  }).join('');
  return out
    .replace(/https?:\/\/\S+/gi, '<string>')
    .replace(/-?\b\d+(?:\.\d+)?\b/g, '<number>');
}

/** Failure names and messages as they leave: clipped, and value-masked in shape-only mode. */
function prepareFailures(failures, shapeOnly) {
  return failures.map(f => ({
    name: clip(shapeOnly ? maskLiterals(f.name) : f.name, MAX_FAILURE_NAME_CHARS),
    error: clip(shapeOnly ? maskLiterals(f.error) : f.error, MAX_FAILURE_ERROR_CHARS),
  }));
}

const MAX_SHAPE_HEADER_NAMES = 50;

/**
 * Shape-only header values that are protocol metadata and safe to send. Each sanitizer returns the
 * value to send, or '' to send the name only (a value that does not look as expected is never sent).
 */
const SAFE_HEADER_VALUES = {
  'content-type': v => {
    const [media, ...params] = v.split(';').map(x => x.trim());
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(media)) return '';
    const charset = params.find(p => /^charset=[\w.-]+$/i.test(p));
    return charset ? `${media}; ${charset}` : media;
  },
  'content-length': v => (/^\d{1,12}$/.test(v.trim()) ? v.trim() : ''),
  'content-encoding': v => (/^[\w, -]{1,40}$/.test(v) ? v.trim() : ''),
  'cache-control': v => (/^[\w=, -]{1,100}$/.test(v) ? v.trim() : ''),
  'www-authenticate': v => {
    const m = /^\s*([A-Za-z][\w-]{0,30})(?:\s|$)/.exec(v);
    return m ? m[1] : '';
  },
};

/** [name, value] pairs as they leave in shape-only mode: every name, values only for the allowlist. */
function shapeHeaders(pairs) {
  const names = [];
  const values = {};
  for (const [k, v] of pairs) {
    if (typeof k !== 'string' || !k) continue;
    if (names.length >= MAX_SHAPE_HEADER_NAMES) break;
    const name = clip(k, 100);
    names.push(name);
    const sanitize = SAFE_HEADER_VALUES[name.toLowerCase()];
    const raw = Array.isArray(v) ? v.join(', ') : v;
    const safe = sanitize && typeof raw === 'string' ? sanitize(raw) : '';
    if (safe) values[name] = safe;
  }
  return { names, values };
}

/** Response headers as they leave (already redacted): trimmed in full mode, names + allowlist in shape-only. */
function prepareResponseHeaders(headers, shapeOnly) {
  if (!shapeOnly) return trimHeaders(headers);
  return shapeHeaders(Object.entries(headers && typeof headers === 'object' ? headers : {}));
}

/** The request as it leaves (already redacted); shape-only reduces its headers the same way. */
function prepareRequest(redReq, name, shapeOnly) {
  const out = trimRequest(redReq, name);
  if (shapeOnly && Array.isArray(redReq.header)) {
    out.headers = shapeHeaders(redReq.header.filter(h => h && h.key && !h.disabled).map(h => [h.key, h.value]));
  }
  return out;
}

/** The test script as it leaves, or undefined when it is not sent (never in shape-only mode). */
function prepareScript(testScript, { redactSecrets, shapeOnly }) {
  if (shapeOnly || !testScript) return undefined;
  return clip(redactSecrets !== false ? redactScript(testScript) : testScript, MAX_SCRIPT_CHARS);
}

function finalizeText(text, { secretValues, redactSecrets }) {
  let out = text;
  if (redactSecrets !== false) out = scrubTokenPatterns(out);
  return scrubSecretValues(out, secretValues);
}

/**
 * What the feature sends besides the request and response, for the preview dialog. Built with the
 * same helpers as the real payload so the preview cannot drift from what is sent.
 */
function describeExplainEvidence({ request, name, response, failures, testScript, variableNames, secretValues, redactSecrets, sendResponseBodies }) {
  const shapeOnly = sendResponseBodies === false;
  const list = prepareFailures(normalizeFailures(failures), shapeOnly);
  const script = prepareScript(typeof testScript === 'string' ? testScript : '', { redactSecrets, shapeOnly });
  const names = (Array.isArray(variableNames) ? variableNames : [])
    .filter(n => typeof n === 'string' && n).slice(0, MAX_VARIABLE_NAMES).map(n => clip(n, MAX_VARIABLE_NAME_CHARS));
  const opts = { secretValues, redactSecrets };
  const section = (label, text) => ({ label, text: finalizeText(text, opts), truncated: false });
  const redReq = redactRequest(request || {}, { secretValues, redactSecrets });
  const redRes = redactResponse(response || {}, { secretValues, redactSecrets });
  const sections = [
    section('Mode', shapeOnly
      ? 'Shape only: the response body is sent as types without values; response and request headers are sent as names only (plus content-type, content-length, content-encoding, cache-control and the www-authenticate scheme); quoted values and numbers in failure names and messages are replaced by placeholders; the test script is not sent.'
      : 'Full: a truncated copy of the response body, the failure messages and the test script are sent.'),
    section('Request (as sent)', JSON.stringify(prepareRequest(redReq, name, shapeOnly), null, 2)),
    section('Response status and headers (as sent)', JSON.stringify({
      status: redRes.status, statusText: clip(redRes.statusText, 80), headers: prepareResponseHeaders(redRes.headers, shapeOnly),
    }, null, 2)),
    section('Failed assertions', JSON.stringify(list, null, 2)),
    section('Test script', script !== undefined ? script : (shapeOnly ? '(not sent in shape-only mode)' : '(none)')),
    section('Variable names (never values)', names.length ? names.join(', ') : '(none)'),
  ];
  return sections;
}

function buildData({ request, name, response, failures, testScript, variableNames, secretValues, redactSecrets, sendResponseBodies, bodyTokens, includeScript }) {
  const redReq = redactRequest(request || {}, { secretValues, redactSecrets });
  const redRes = redactResponse(response || {}, { secretValues, redactSecrets });
  const data = {
    request: prepareRequest(redReq, name, sendResponseBodies === false),
    response: { status: redRes.status, statusText: clip(redRes.statusText, 80), headers: prepareResponseHeaders(redRes.headers, sendResponseBodies === false) },
    failedAssertions: prepareFailures(failures, sendResponseBodies === false),
  };
  const latency = normalizeLatency(response && response.responseTime);
  if (latency !== undefined) data.response.responseTimeMs = latency;
  let truncated = false;
  const body = typeof redRes.body === 'string' ? redRes.body : '';
  const parsed = tryParse(body);
  if (sendResponseBodies === false) {
    data.response.bodyShape = parsed.ok ? buildShapeSchema(parsed.value) : { type: 'text', length: body.length };
    data.response.bodyNote = 'Shape only: types, no values.';
  } else if (parsed.ok) {
    const tj = truncateJson(parsed.value, { maxTokens: bodyTokens });
    data.response.body = tj.value;
    truncated = tj.truncated;
    if (truncated) data.response.bodyNote = 'The body is truncated.';
  } else if (body) {
    const t = truncateText(body, bodyTokens);
    data.response.body = t.text;
    truncated = t.truncated;
    data.response.bodyNote = 'The body is not JSON.';
  }
  if (sendResponseBodies === false) {
    if (testScript) data.testScriptNote = 'Test script not sent (shape-only mode).';
  } else if (includeScript && testScript) {
    data.testScript = prepareScript(testScript, { redactSecrets, shapeOnly: false });
  }
  if (variableNames.length) data.variableNames = variableNames;
  return { text: finalizeText(JSON.stringify(data, null, 1), { secretValues, redactSecrets }), truncated };
}

/** Largest body that keeps the whole prompt (system + user) inside the budget. */
function fitPrompt(args, language, maxContextTokens) {
  const reserve = Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(maxContextTokens * 0.35));
  let bodyTokens = Math.max(MIN_BODY_TOKENS, maxContextTokens - reserve - 900);
  let includeScript = true;
  for (let attempt = 0; attempt < 12; attempt++) {
    const built = buildData({ ...args, bodyTokens, includeScript });
    const prompt = getPrompt('explainFailure', { language, data: built.text });
    const cost = estimateTokens(prompt.system) + estimateTokens(prompt.user) + reserve;
    if (cost <= maxContextTokens) return { prompt, truncated: built.truncated, cost };
    if (bodyTokens > MIN_BODY_TOKENS) bodyTokens = Math.max(MIN_BODY_TOKENS, Math.floor(bodyTokens / 2));
    else if (includeScript) includeScript = false;
    else break;
  }
  throw new AiError('TOO_LARGE', 'The request and response are too large for the configured context limit');
}

function cleanLine(v, max, secretValues) {
  if (typeof v !== 'string') return '';
  return scrubSecretValues(neutralizeAiText(v), secretValues).replace(/\s+/g, ' ').trim().slice(0, max);
}

const UNSAFE_SNIPPET_WORDS = /\b(fetch|XMLHttpRequest|WebSocket|sendRequest|require|import|eval|Function|process|constructor|__proto__)\b/;
const SNIPPET_URL = /https?:\/\/(?!\{\{)/i;
const SNIPPET_HOST = /(?<![:\w{}/])\/\/(?!\{\{)[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

function isUnsafeSnippet(snippet) {
  return UNSAFE_SNIPPET_WORDS.test(snippet) || SNIPPET_URL.test(snippet) || SNIPPET_HOST.test(snippet);
}

/** Keep known fields only, enforce enums and bounds. A snippet keeps its line breaks. */
function sanitizeExplanation(data, secretValues) {
  const d = data && typeof data === 'object' ? data : {};
  const likelyCauses = [];
  for (const c of Array.isArray(d.likelyCauses) ? d.likelyCauses : []) {
    const cause = cleanLine(c && c.cause, MAX_TEXT_CHARS, secretValues);
    if (!cause) continue;
    likelyCauses.push({ cause, confidence: CONFIDENCES.includes(c.confidence) ? c.confidence : 'low' });
    if (likelyCauses.length >= MAX_CAUSES) break;
  }
  const suggestedFixes = [];
  for (const f of Array.isArray(d.suggestedFixes) ? d.suggestedFixes : []) {
    const description = cleanLine(f && f.description, MAX_TEXT_CHARS, secretValues);
    if (!description) continue;
    const fix = { description, kind: FIX_KINDS.includes(f.kind) ? f.kind : 'other' };
    if (typeof f.snippet === 'string' && f.snippet.trim()) {
      // Plain text for a <pre>: secrets scrubbed, never run, bounded. Defence in depth: a snippet that
      // reaches out (network, code loading, eval, prototype tricks) or points at a host is dropped.
      if (isUnsafeSnippet(f.snippet)) {
        fix.description = `${description} (A code snippet was removed because it did not look safe.)`.slice(0, MAX_TEXT_CHARS + 60);
      } else {
        fix.snippet = scrubSecretValues(f.snippet, secretValues).trim().slice(0, MAX_SNIPPET_CHARS);
      }
    }
    suggestedFixes.push(fix);
    if (suggestedFixes.length >= MAX_FIXES) break;
  }
  return { summary: cleanLine(d.summary, MAX_SUMMARY_CHARS, secretValues), likelyCauses, suggestedFixes };
}

function normalizeFailures(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || typeof f !== 'object' || typeof f.name !== 'string') continue;
    out.push({ name: f.name, error: typeof f.error === 'string' ? f.error : '' });
    if (out.length >= MAX_FAILURES) break;
  }
  return out;
}

/**
 * @param {{ provider: { complete: Function }, request?: object, name?: string,
 *   response: { status?: number, statusText?: string, headers?: object, body?: string, responseTime?: number },
 *   failures: Array<{ name: string, error?: string }>, testScript?: string, variableNames?: string[],
 *   maxContextTokens?: number, redactSecrets?: boolean, sendResponseBodies?: boolean,
 *   secretValues?: string[], language?: string, signal?: AbortSignal }} input
 */
async function explainFailure(input) {
  const { provider, request, name, response, testScript, secretValues, language, signal } = input;
  const failures = normalizeFailures(input.failures);
  if (!failures.length) throw Object.assign(new Error('There is no failed assertion to explain'), { code: 'BAD_REQUEST' });
  const maxContextTokens = input.maxContextTokens > 0 ? input.maxContextTokens : 8000;
  const variableNames = (Array.isArray(input.variableNames) ? input.variableNames : [])
    .filter(n => typeof n === 'string' && n).slice(0, MAX_VARIABLE_NAMES).map(n => clip(n, MAX_VARIABLE_NAME_CHARS));
  const { prompt, truncated } = fitPrompt({
    request, name, response, failures, testScript: testScript || '', variableNames, secretValues,
    redactSecrets: input.redactSecrets !== false, sendResponseBodies: input.sendResponseBodies !== false,
  }, language, maxContextTokens);
  const r = await provider.complete({
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    schema: 'explainFailure',
    signal,
    maxTokens: OUTPUT_RESERVE_TOKENS,
  });
  const explanation = sanitizeExplanation(r.data, secretValues);
  if (!explanation.summary) throw new AiError('INVALID_OUTPUT', 'The model returned an empty explanation');
  return { ...explanation, truncated, shapeOnly: input.sendResponseBodies === false, usage: r.usage, model: r.model, latencyMs: r.latencyMs };
}

module.exports = { explainFailure, sanitizeExplanation, buildData, fitPrompt, maskLiterals, describeExplainEvidence };
