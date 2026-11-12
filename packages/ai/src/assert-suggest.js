'use strict';

/**
 * Ask the model for assertions on one captured response, then keep only the ones that actually pass.
 *
 * Trust model: the request, the response and the existing tests are untrusted data (wrapUntrusted).
 * What comes back is untrusted too: it is schema-checked, size-bounded, text-neutralised and dry-run
 * in the real script sandbox on the response that inspired it. A suggestion that cannot be validated
 * never reaches the caller. Nothing is applied here.
 */

const { neutralizeAiText } = require('@apilix/core/docs');
const { AiError } = require('./errors');
const { estimateTokens, truncateText, truncateJson } = require('./budget');
const { redactRequest, redactResponse, redactScript, scrubSecretValues, scrubTokenPatterns } = require('./redact');
const { buildShapeSchema } = require('./context');
const { getPrompt } = require('./prompts');
const { dryRunScript } = require('./dry-run');

const KINDS = ['status', 'header', 'body', 'schema', 'timing', 'capture'];
const CONFIDENCES = ['high', 'medium', 'low'];
const MAX_SUGGESTIONS = 20;
const MAX_TITLE_CHARS = 120;
const MAX_SCRIPT_CHARS = 4000;
const MAX_DISCARDED_REPORTED = 10;
const DRY_RUN_BUDGET_MS = 20000;
const OUTPUT_RESERVE_TOKENS = 3000;
const MAX_URL_CHARS = 300;
const MAX_NAME_CHARS = 200;
const MAX_HEADERS = 25;
const MAX_HEADER_VALUE_CHARS = 150;
const MAX_REQUEST_BODY_CHARS = 800;
const MAX_EXISTING_TESTS_CHARS = 1500;
const MIN_BODY_TOKENS = 50;

function clip(v, max) {
  const s = v === undefined || v === null ? '' : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

function trimHeaders(headers) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    if (n++ >= MAX_HEADERS) break;
    out[clip(k, 100)] = clip(Array.isArray(v) ? v.join(', ') : v, MAX_HEADER_VALUE_CHARS);
  }
  return out;
}

function trimRequest(redacted, name) {
  const out = { name: clip(name, MAX_NAME_CHARS), method: redacted.method, url: clip(redacted.url, MAX_URL_CHARS) };
  if (Array.isArray(redacted.header)) {
    out.headers = redacted.header.filter(h => h && h.key && !h.disabled).slice(0, MAX_HEADERS).map(h => ({ key: clip(h.key, 100), value: clip(h.value, MAX_HEADER_VALUE_CHARS) }));
  }
  const b = redacted.body;
  if (b && b.mode === 'raw' && typeof b.raw === 'string') out.body = clip(b.raw, MAX_REQUEST_BODY_CHARS);
  else if (b && (b.mode === 'formdata' || b.mode === 'urlencoded')) {
    out.body = (b[b.mode] || []).slice(0, 20).map(p => ({ key: clip(p.key, 100) }));
  }
  return out;
}

/** The text sent for one budget level. Returns the data object and whether the body was cut. */
function buildData({ request, name, response, existingTests, secretValues, redactSecrets, sendResponseBodies, bodyTokens, includeExisting }) {
  const redReq = redactRequest(request || {}, { secretValues, redactSecrets });
  const redRes = redactResponse(response || {}, { secretValues, redactSecrets });
  const data = {
    request: trimRequest(redReq, name),
    response: { status: redRes.status, statusText: clip(redRes.statusText, 80), headers: trimHeaders(redRes.headers) },
  };
  let truncated = false;
  const body = typeof redRes.body === 'string' ? redRes.body : '';
  const parsed = tryParse(body);
  if (sendResponseBodies === false) {
    data.response.bodyShape = parsed.ok ? buildShapeSchema(parsed.value) : { type: 'text', length: body.length };
    data.response.bodyNote = 'Shape only: types, no values. Assert types and structure, never values.';
  } else if (parsed.ok) {
    const tj = truncateJson(parsed.value, { maxTokens: bodyTokens });
    data.response.body = tj.value;
    truncated = tj.truncated;
    if (truncated) data.response.bodyNote = 'The body is truncated: only assert what is visible.';
  } else if (body) {
    const t = truncateText(body, bodyTokens);
    data.response.body = t.text;
    truncated = t.truncated;
    data.response.bodyNote = 'The body is not JSON.';
  }
  if (includeExisting && existingTests) {
    const redacted = redactSecrets !== false ? redactScript(existingTests) : existingTests;
    data.existingTests = clip(redacted, MAX_EXISTING_TESTS_CHARS);
  }
  let text = JSON.stringify(data, null, 1);
  if (redactSecrets !== false) text = scrubTokenPatterns(text);
  text = scrubSecretValues(text, secretValues);
  return { text, truncated };
}

/** Largest body that keeps the whole prompt (system + user) inside the budget. */
function fitPrompt(args, language, maxContextTokens) {
  // Part of the limit is kept for the answer; on a small limit the reserve shrinks instead of failing outright.
  const reserve = Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(maxContextTokens * 0.35));
  let bodyTokens = Math.max(MIN_BODY_TOKENS, maxContextTokens - reserve - 900);
  let includeExisting = true;
  for (let attempt = 0; attempt < 12; attempt++) {
    const built = buildData({ ...args, bodyTokens, includeExisting });
    const prompt = getPrompt('assertSuggest', { language, data: built.text });
    // Cost what is actually sent: system prompt + the user message, delimiters included.
    const cost = estimateTokens(prompt.system) + estimateTokens(prompt.user) + reserve;
    if (cost <= maxContextTokens) return { prompt, truncated: built.truncated, cost };
    if (bodyTokens > MIN_BODY_TOKENS) bodyTokens = Math.max(MIN_BODY_TOKENS, Math.floor(bodyTokens / 2));
    else if (includeExisting) includeExisting = false;
    else break;
  }
  throw new AiError('TOO_LARGE', 'The request and response are too large for the configured context limit');
}

function cleanTitle(v) {
  if (typeof v !== 'string') return '';
  return neutralizeAiText(v).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
}

/** Keep known fields only, enforce enums and bounds, drop duplicates. */
function sanitizeSuggestions(items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    const title = cleanTitle(it.title);
    const script = typeof it.script === 'string' ? it.script.trim() : '';
    if (!title || !script || script.length > MAX_SCRIPT_CHARS) continue;
    if (!KINDS.includes(it.kind)) continue;
    const key = `${title}\n${script}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      kind: it.kind,
      script,
      confidence: CONFIDENCES.includes(it.confidence) ? it.confidence : 'low',
      ...(it.volatile === true ? { volatile: true } : {}),
    });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/**
 * @param {{ provider: { complete: Function }, request?: object, name?: string,
 *   response: { status?: number, statusText?: string, headers?: object, body?: string, responseTime?: number },
 *   existingTests?: string, maxContextTokens?: number, redactSecrets?: boolean, sendResponseBodies?: boolean,
 *   secretValues?: string[], language?: string, signal?: AbortSignal }} input
 */
async function suggestAssertions(input) {
  const { provider, request, name, response, existingTests, secretValues, language, signal } = input;
  const maxContextTokens = input.maxContextTokens > 0 ? input.maxContextTokens : 8000;
  const redactSecrets = input.redactSecrets !== false;
  const sendResponseBodies = input.sendResponseBodies !== false;

  const { prompt, truncated } = fitPrompt(
    { request, name, response, existingTests, secretValues, redactSecrets, sendResponseBodies },
    language,
    maxContextTokens,
  );
  const r = await provider.complete({
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    schema: 'assertSuggest',
    signal,
    maxTokens: OUTPUT_RESERVE_TOKENS,
  });

  const candidates = sanitizeSuggestions(r.data && r.data.suggestions);
  const suggestions = [];
  const discarded = [];
  const deadline = Date.now() + DRY_RUN_BUDGET_MS;
  for (const c of candidates) {
    if (signal && signal.aborted) throw new AiError('ABORTED', 'The request was cancelled');
    let verdict;
    if (Date.now() > deadline) verdict = { ok: false, reason: 'validation time budget exhausted' };
    else verdict = await dryRunScript(c.script, { response, mode: 'strict', expects: c.kind === 'capture' ? 'capture' : 'test' });
    if (verdict.ok) suggestions.push({ id: `ai${suggestions.length + 1}`, ...c });
    else discarded.push({ title: c.title, reason: cleanTitle(verdict.reason || 'failed validation') });
  }
  return {
    suggestions,
    discarded: discarded.slice(0, MAX_DISCARDED_REPORTED),
    discardedCount: discarded.length,
    truncated,
    shapeOnly: !sendResponseBodies,
    usage: r.usage,
    model: r.model,
    latencyMs: r.latencyMs,
  };
}

module.exports = { suggestAssertions, sanitizeSuggestions, buildData, fitPrompt, KINDS };
