'use strict';

/**
 * "Summarize this run": the model explains groups of failures found by a collection run.
 *
 * The client already grouped the failures deterministically (same base URL, same status, same message). What
 * is sent is aggregated metadata only: per group a count, the method, the URL TEMPLATE (id-like segments
 * replaced, query values dropped, userinfo dropped), the status, the failure message and at most 3 examples
 * (request name, status and failed assertion names/messages). Every free text is value-masked (quoted strings,
 * emails, URLs and numbers become placeholders) in every mode. Never a request or response body, never a
 * header, never a variable value. Everything is re-sanitised here: the client is not trusted.
 *
 * What comes back is untrusted text (schema-checked, bounded, neutralised, scrubbed of secret values) shown
 * next to the run; it is never applied and nothing is executed.
 */

const { neutralizeAiText } = require('@apilix/core/docs');
const { AiError } = require('./errors');
const { estimateTokens } = require('./budget');
const { scrubSecretValues, scrubTokenPatterns } = require('./redact');
const { getPrompt } = require('./prompts');
const { clip, maskLiterals, shapeUrl } = require('./shape');

const MAX_GROUPS = 30;
const MAX_EXAMPLES = 3;
const MAX_FAILURES_PER_EXAMPLE = 3;
const MAX_NAME_CHARS = 150;
const MAX_MESSAGE_CHARS = 300;
const MAX_URL_CHARS = 300;
const MAX_SUMMARY_CHARS = 800;
const MAX_NOTE_CHARS = 400;
const OUTPUT_RESERVE_TOKENS = 1500;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function text(v, max, { shapeOnly, redactSecrets, secretValues }) {
  let s = typeof v === 'string' ? v : '';
  if (!s) return '';
  s = clip(shapeOnly ? maskLiterals(s) : s, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  if (redactSecrets) s = scrubTokenPatterns(s);
  return scrubSecretValues(s, secretValues);
}

/**
 * Normalise what the client sent into what leaves. Pure; the preview uses the same function.
 * @returns {{ totals: { requests: number, failedRequests: number, groups: number }, groups: object[], omittedGroups: number }}
 */
function prepareRunData(input) {
  // Free text (names, messages, failure texts) is ALWAYS value-masked, whatever sendResponseBodies says: an assertion
  // message quotes values taken from a response, and a run summary has no need of them.
  const opts = { shapeOnly: true, redactSecrets: input.redactSecrets !== false, secretValues: input.secretValues };
  const t = isObj(input.totals) ? input.totals : {};
  const rawGroups = (Array.isArray(input.groups) ? input.groups : []).filter(isObj);
  const groups = rawGroups.slice(0, MAX_GROUPS).map((g, i) => ({
    id: `g${i + 1}`,
    count: int(g.count, 1, 1e7) ?? 1,
    method: METHODS.has(String(g.method).toUpperCase()) ? String(g.method).toUpperCase() : '',
    url: text(shapeUrl(typeof g.url === 'string' ? g.url : ''), MAX_URL_CHARS, { ...opts, shapeOnly: false }),
    status: int(g.status, 0, 599) ?? 0,
    message: text(g.message, MAX_MESSAGE_CHARS, opts),
    examples: (Array.isArray(g.examples) ? g.examples : []).filter(isObj).slice(0, MAX_EXAMPLES).map(e => ({
      request: text(e.name, MAX_NAME_CHARS, opts),
      method: METHODS.has(String(e.method).toUpperCase()) ? String(e.method).toUpperCase() : '',
      url: text(shapeUrl(typeof e.url === 'string' ? e.url : ''), MAX_URL_CHARS, { ...opts, shapeOnly: false }),
      status: int(e.status, 0, 599) ?? 0,
      failures: (Array.isArray(e.failures) ? e.failures : []).filter(isObj).slice(0, MAX_FAILURES_PER_EXAMPLE).map(f => ({
        name: text(f.name, MAX_NAME_CHARS, opts),
        error: text(f.error, MAX_MESSAGE_CHARS, opts),
      })),
    })),
  }));
  return {
    totals: { requests: int(t.requests, 0, 1e9) ?? 0, failedRequests: int(t.failedRequests, 0, 1e9) ?? 0, groups: int(t.groups, 0, 1e9) ?? rawGroups.length },
    groups,
    omittedGroups: Math.max(0, rawGroups.length - MAX_GROUPS) + (int(t.groups, 0, 1e9) !== undefined ? Math.max(0, t.groups - rawGroups.length) : 0),
  };
}

/** Sections for the preview dialog, built from the very same data. */
function describeRunSummary(input) {
  const data = prepareRunData(input);
  return [
    { label: 'Mode', text: `Only aggregated metadata is sent: counts, URL templates (ids and query values removed), statuses, and failure messages and names with every quoted string, email, URL and number replaced by placeholders, for at most ${MAX_EXAMPLES} examples per group. No body, header or variable value is sent.`, truncated: false },
    { label: 'Run groups (as sent)', text: JSON.stringify(data, null, 1), truncated: data.omittedGroups > 0 },
  ];
}

function fit(input, language, maxContextTokens) {
  const reserve = Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(maxContextTokens * 0.35));
  let data = prepareRunData(input);
  for (let attempt = 0; attempt < 40; attempt++) {
    const prompt = getPrompt('summarizeRun', { language, data: JSON.stringify(data, null, 1) });
    if (estimateTokens(prompt.system) + estimateTokens(prompt.user) + reserve <= maxContextTokens) return { prompt, data };
    // Shrink: fewer examples first, then fewer groups (the smallest are dropped).
    if (data.groups.some(g => g.examples.length > 1)) data = { ...data, groups: data.groups.map(g => ({ ...g, examples: g.examples.slice(0, Math.max(1, g.examples.length - 1)) })) };
    else if (data.groups.some(g => g.examples.length > 0)) data = { ...data, groups: data.groups.map(g => ({ ...g, examples: [] })) };
    else if (data.groups.length > 1) data = { ...data, omittedGroups: data.omittedGroups + 1, groups: data.groups.slice(0, -1) };
    else break;
  }
  throw new AiError('TOO_LARGE', 'The run summary is too large for the configured context limit');
}

function cleanLine(v, max, secretValues) {
  if (typeof v !== 'string') return '';
  return scrubSecretValues(neutralizeAiText(v), secretValues).replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeSummary(data, validIds, secretValues) {
  const d = isObj(data) ? data : {};
  const groups = [];
  for (const g of Array.isArray(d.groups) ? d.groups : []) {
    if (!isObj(g) || typeof g.id !== 'string' || !validIds.has(g.id) || groups.some(x => x.id === g.id)) continue;
    const cause = cleanLine(g.cause, MAX_NOTE_CHARS, secretValues);
    if (!cause) continue;
    const nextStep = cleanLine(g.nextStep, MAX_NOTE_CHARS, secretValues);
    groups.push({ id: g.id, cause, ...(nextStep ? { nextStep } : {}) });
  }
  return { summary: cleanLine(d.summary, MAX_SUMMARY_CHARS, secretValues), groups };
}

/**
 * @param {{ provider: { complete: Function }, totals?: object, groups: object[], maxContextTokens?: number,
 *   redactSecrets?: boolean, sendResponseBodies?: boolean, secretValues?: string[], language?: string, signal?: AbortSignal }} input
 */
async function summarizeRun(input) {
  const { provider, language, signal, secretValues } = input;
  if (!Array.isArray(input.groups) || !input.groups.some(isObj)) throw Object.assign(new Error('groups must list at least one failure group'), { code: 'BAD_REQUEST' });
  const maxContextTokens = input.maxContextTokens > 0 ? input.maxContextTokens : 8000;
  const { prompt, data } = fit(input, language, maxContextTokens);
  const r = await provider.complete({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }], schema: 'runSummary', signal, maxTokens: OUTPUT_RESERVE_TOKENS });
  const out = sanitizeSummary(r.data, new Set(data.groups.map(g => g.id)), secretValues);
  if (!out.summary) throw new AiError('INVALID_OUTPUT', 'The model returned an empty summary');
  return { ...out, sentGroups: data.groups.length, omittedGroups: data.omittedGroups, shapeOnly: input.sendResponseBodies === false, usage: r.usage, model: r.model, latencyMs: r.latencyMs };
}

module.exports = { summarizeRun, describeRunSummary, prepareRunData, sanitizeSummary, MAX_GROUPS, MAX_EXAMPLES };
