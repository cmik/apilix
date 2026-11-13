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

function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

function buildData({ request, name, response, failures, testScript, variableNames, secretValues, redactSecrets, sendResponseBodies, bodyTokens, includeScript }) {
  const redReq = redactRequest(request || {}, { secretValues, redactSecrets });
  const redRes = redactResponse(response || {}, { secretValues, redactSecrets });
  const data = {
    request: trimRequest(redReq, name),
    response: { status: redRes.status, statusText: clip(redRes.statusText, 80), headers: trimHeaders(redRes.headers) },
    failedAssertions: failures.map(f => ({ name: clip(f.name, MAX_FAILURE_NAME_CHARS), error: clip(f.error, MAX_FAILURE_ERROR_CHARS) })),
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
  if (includeScript && testScript) {
    const redacted = redactSecrets !== false ? redactScript(testScript) : testScript;
    data.testScript = clip(redacted, MAX_SCRIPT_CHARS);
  }
  if (variableNames.length) data.variableNames = variableNames;
  let text = JSON.stringify(data, null, 1);
  if (redactSecrets !== false) text = scrubTokenPatterns(text);
  text = scrubSecretValues(text, secretValues);
  return { text, truncated };
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
      // Plain text for a <pre>: secrets scrubbed, never run, bounded.
      fix.snippet = scrubSecretValues(f.snippet, secretValues).trim().slice(0, MAX_SNIPPET_CHARS);
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

module.exports = { explainFailure, sanitizeExplanation, buildData, fitPrompt };
