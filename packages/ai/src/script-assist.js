'use strict';

/**
 * Scripting assistant: generate | explain | fix | convert for apx.* scripts.
 *
 * Trust model (same as the other AI features):
 *  - the user's instruction is trusted input; the script, the console error and the variable names are
 *    data (wrapUntrusted), redacted before they leave, and the console error is value-masked in shape-only
 *    mode (it can quote response values). The script itself is the subject of the request and is sent as
 *    written, with secrets redacted: the preview shows exactly that text;
 *  - what comes back is untrusted: schema-checked, bounded, neutralised, re-scrubbed of secret values;
 *  - a proposed script is NEVER run by the caller. It goes through the static screen and then the
 *    isolated dry-run (dry-run.js: parse-only when isolation is not proven). A validation error triggers
 *    one automatic retry with the error; if it still fails the script is offered marked "not validated".
 *    A script the screen refuses (require('fs'), eval, process...) is dropped, never offered;
 *  - convert is deterministic first (script-convert.js): the model only sees what is left.
 */

const { neutralizeAiText } = require('@apilix/core/docs');
const { AiError } = require('./errors');
const { estimateTokens } = require('./budget');
const { redactScript, scrubSecretValues, scrubTokenPatterns } = require('./redact');
const { getPrompt, stripDelimiters, SCRIPT_MODES } = require('./prompts');
const { clip, maskLiterals } = require('./shape');
const { dryRunScript } = require('./dry-run');
const { MAX_SCRIPT_CHARS: MAX_SCREENED_CHARS } = require('./script-screen');
const { convertPmToApx } = require('./script-convert');
const { maskScriptLiterals } = require('./script-mask');

const KINDS = ['test', 'prerequest'];
const MAX_INPUT_SCRIPT_CHARS = 20000;
const MAX_INSTRUCTION_CHARS = 1000;
const MAX_ERROR_CHARS = 800;
const MAX_VARIABLES = 200;
const MAX_VARIABLE_NAME_CHARS = 100;
const MAX_EXPLANATION_CHARS = 1500;
const MAX_REMAINING = 20;
const OUTPUT_RESERVE_TOKENS = 3000;

// Names that make a script dangerous in this context; reported as `flags` so the UI can say why a script was dropped.
const FLAG_RE = /\b(require|process|child_process|import|eval|Function|fetch|XMLHttpRequest|WebSocket|globalThis|constructor|__proto__)\b/g;

function badRequest(message) { return Object.assign(new Error(message), { code: 'BAD_REQUEST' }); }

function cleanInstruction(text, { redactSecrets, secretValues }) {
  let s = stripDelimiters(String(text || '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (redactSecrets) s = scrubTokenPatterns(s);
  return scrubSecretValues(s, secretValues).slice(0, MAX_INSTRUCTION_CHARS);
}

function cleanVariableNames(list) {
  return (Array.isArray(list) ? list : []).filter(n => typeof n === 'string' && n).slice(0, MAX_VARIABLES).map(n => clip(n, MAX_VARIABLE_NAME_CHARS));
}

/**
 * The script as it leaves: in shape-only mode its string and number literals are replaced first (it is CONTEXT only,
 * never offered back); then secrets are redacted (unless the user turned redaction off, which never applies to secret values).
 */
function prepareScript(script, { redactSecrets, secretValues, shapeOnly }) {
  let s = typeof script === 'string' ? script : '';
  if (shapeOnly) s = maskScriptLiterals(s);
  if (redactSecrets) s = redactScript(s);
  return scrubSecretValues(s, secretValues);
}

function prepareError(error, { shapeOnly, redactSecrets, secretValues }) {
  let s = typeof error === 'string' ? error : '';
  if (!s) return '';
  s = clip(shapeOnly ? maskLiterals(s) : s, MAX_ERROR_CHARS);
  if (redactSecrets) s = scrubTokenPatterns(s);
  return scrubSecretValues(s, secretValues);
}

/** Validate and normalise the request fields shared by the route, the preview and the assistant. */
function normalizeInput(input) {
  const mode = input.mode;
  if (!SCRIPT_MODES.includes(mode)) throw badRequest(`mode must be one of ${SCRIPT_MODES.join(', ')}`);
  const kind = input.kind === undefined ? 'test' : input.kind;
  if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
  const script = input.script === undefined ? '' : input.script;
  if (typeof script !== 'string') throw badRequest('script must be a string');
  if (script.length > MAX_INPUT_SCRIPT_CHARS) throw badRequest(`script is longer than ${MAX_INPUT_SCRIPT_CHARS} characters`);
  if (input.error !== undefined && typeof input.error !== 'string') throw badRequest('error must be a string');
  if (input.instruction !== undefined && typeof input.instruction !== 'string') throw badRequest('instruction must be a string');
  if (mode === 'generate' && !(input.instruction || '').trim()) throw badRequest('instruction must be a non-empty string');
  if (mode !== 'generate' && !script.trim()) throw badRequest('script must not be empty');
  if (mode === 'fix' && !(input.error || '').trim()) throw badRequest('error must be a non-empty string');
  return { mode, kind, script, error: input.error || '', instruction: input.instruction || '' };
}

function buildData({ kind, script, error, variableNames, remaining }, opts) {
  const data = { kind: kind === 'prerequest' ? 'pre-request script' : 'test script', currentScript: prepareScript(script, opts) || '(none)' };
  const err = prepareError(error, opts);
  if (err) data.errorMessage = err;
  if (remaining && remaining.length) data.unsupportedMembers = remaining.map(r => `${r.path} (line ${r.line})`);
  if (variableNames.length) data.variableNames = variableNames;
  const text = JSON.stringify(data, null, 1);
  return scrubSecretValues(opts.redactSecrets ? scrubTokenPatterns(text) : text, opts.secretValues);
}

/**
 * What the feature sends, for the preview dialog. Built with the SAME helpers as the real payload.
 * @returns {{ sections: Array<{label:string,text:string,truncated:boolean}>, deterministic: boolean }}
 */
function describeScriptAssist(input) {
  const n = normalizeInput(input);
  const redactSecrets = input.redactSecrets !== false;
  const shapeOnly = input.sendResponseBodies === false;
  const secretValues = input.secretValues;
  const variableNames = cleanVariableNames(input.variableNames);
  const opts = { redactSecrets, shapeOnly, secretValues };
  let script = n.script;
  let remaining = [];
  let deterministic = false;
  if (n.mode === 'convert') {
    const c = convertPmToApx(n.script);
    script = c.script;
    remaining = c.remaining.slice(0, MAX_REMAINING);
    deterministic = remaining.length === 0;
  }
  const section = (label, text) => ({ label, text, truncated: false });
  const sections = [
    section('Mode', `${n.mode} (${n.kind === 'prerequest' ? 'pre-request' : 'test'} script). ${shapeOnly
      ? 'Shape only: string and number values in the script (and quoted values in the console error) are replaced by placeholders; comments are dropped. Names, calls and structure are sent. Secrets are redacted.'
      : 'The script and the console error are sent as written (secrets redacted).'}`),
  ];
  if (deterministic) {
    sections.push(section('Nothing is sent', 'This script converts completely with the built-in rules: no AI call is made.'));
    return { sections, deterministic };
  }
  if (n.mode === 'generate' && n.instruction) sections.push(section('Instruction', cleanInstruction(n.instruction, opts)));
  sections.push(section('Script, error and variable names (as sent)', buildData({ kind: n.kind, script, error: n.error, variableNames, remaining }, opts)));
  return { sections, deterministic };
}

function cleanText(v, max, secretValues) {
  if (typeof v !== 'string') return '';
  return scrubSecretValues(neutralizeAiText(v), secretValues).replace(/\s+/g, ' ').trim().slice(0, max);
}

function standInResponse(script) {
  const m = /(?:code|status)[^;\n]{0,40}?\b([1-5]\d\d)\b/.exec(script || '');
  return { status: m ? Number(m[1]) : 200, statusText: '', headers: { 'content-type': 'application/json' }, body: '{}', responseTime: 100 };
}

/**
 * Screen + dry-run one script. NEVER runs it in this process.
 * @returns {Promise<{ ok: boolean, executed: boolean, refused?: boolean, infra?: boolean, reason?: string }>}
 */
async function validateScript(code) {
  if (typeof code === 'string' && code.length > MAX_SCREENED_CHARS) return { ok: false, executed: false, refused: true, reason: `script is longer than ${MAX_SCREENED_CHARS} characters` };
  const v = await dryRunScript(code, { response: standInResponse(code), mode: 'lenient' });
  if (!v.ok) return { ok: false, executed: false, reason: clip(neutralizeAiText(v.reason || 'failed'), 240), ...(v.screened === false ? { refused: true } : {}), ...(v.infra ? { infra: true } : {}) };
  return { ok: true, executed: v.executed !== false };
}

function flagsOf(code) {
  return [...new Set((typeof code === 'string' ? code.match(FLAG_RE) : null) || [])].slice(0, 10);
}

/**
 * @param {{ provider: { complete: Function }, mode: 'generate'|'explain'|'fix'|'convert', kind?: 'test'|'prerequest',
 *   script?: string, instruction?: string, error?: string, variableNames?: string[], maxContextTokens?: number,
 *   redactSecrets?: boolean, sendResponseBodies?: boolean, secretValues?: string[], language?: string, signal?: AbortSignal }} input
 * @returns {Promise<{ mode: string, explanation: string, script?: string, deterministic: boolean, usedModel: boolean,
 *   converted?: { renamed: number, legacy: number, remaining: Array<{path:string,line:number,reason:string}> },
 *   validation?: { validated: boolean, executed: boolean, errors: Array<{reason:string}>, refused?: string, flags: string[] },
 *   maskedInput?: boolean,
 *   warnings: string[], retried: boolean, usage: { inputTokens: number, outputTokens: number } }>}
 */
async function scriptAssist(input) {
  const { provider, signal, secretValues, language } = input;
  const n = normalizeInput(input);
  const redactSecrets = input.redactSecrets !== false;
  const shapeOnly = input.sendResponseBodies === false;
  const maxContextTokens = input.maxContextTokens > 0 ? input.maxContextTokens : 8000;
  const variableNames = cleanVariableNames(input.variableNames);
  const opts = { redactSecrets, shapeOnly, secretValues };
  const usage = { inputTokens: 0, outputTokens: 0 };
  const warnings = [];

  let workScript = n.script;
  let converted;
  if (n.mode === 'convert') {
    const c = convertPmToApx(n.script);
    workScript = c.script;
    converted = { renamed: c.renamed, legacy: c.legacy, remaining: c.remaining.slice(0, MAX_REMAINING) };
    if (!c.remaining.length) {
      // Fully deterministic: no model call. The result goes through the same gate as anything else.
      const v = c.changed ? await validateScript(c.script) : { ok: true, executed: false };
      const refusedReason = v.refused ? v.reason : undefined;
      if (refusedReason) warnings.push('The converted script uses constructs a validated script may not use: it was not validated. Review it before use.');
      if (v.ok && !v.executed) warnings.push('The converted script was NOT executed: it only passed the security screen and a syntax check.');
      return {
        mode: 'convert', deterministic: true, usedModel: false, converted, script: c.script,
        explanation: c.changed ? `Converted automatically: ${c.renamed} pm reference${c.renamed === 1 ? '' : 's'} renamed to apx${c.legacy ? `, ${c.legacy} legacy Postman construct${c.legacy === 1 ? '' : 's'} rewritten` : ''}. Nothing needed an AI.` : 'The script already uses apx only: nothing to convert.',
        validation: { validated: v.ok && v.executed === true, executed: v.executed === true, errors: v.ok ? [] : [{ reason: v.reason }], ...(refusedReason ? { refused: refusedReason } : {}), flags: flagsOf(c.script) },
        warnings, retried: false, usage,
      };
    }
  }

  const prepared = () => {
    const data = buildData({ kind: n.kind, script: workScript, error: n.error, variableNames, remaining: converted && converted.remaining }, opts);
    const prompt = getPrompt('scriptAssist', { language, data, instruction: n.mode === 'generate' ? cleanInstruction(n.instruction, opts) : '', mode: n.mode });
    const cost = estimateTokens(prompt.system) + estimateTokens(prompt.user) + Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(maxContextTokens * 0.35));
    if (cost > maxContextTokens) throw new AiError('TOO_LARGE', 'The script is too large for the configured context limit');
    return prompt;
  };
  const prompt = prepared();

  const ask = async (messages) => {
    const r = await provider.complete({ system: prompt.system, messages, schema: 'scriptAssist', signal, maxTokens: OUTPUT_RESERVE_TOKENS });
    usage.inputTokens += (r.usage && r.usage.inputTokens) || 0;
    usage.outputTokens += (r.usage && r.usage.outputTokens) || 0;
    return r;
  };

  const sanitize = (data) => {
    const d = data && typeof data === 'object' ? data : {};
    const explanation = cleanText(d.explanation, MAX_EXPLANATION_CHARS, secretValues);
    let script = typeof d.script === 'string' ? scrubSecretValues(d.script, secretValues).trim() : '';
    if (script.length > MAX_SCREENED_CHARS * 2) script = script.slice(0, MAX_SCREENED_CHARS * 2);
    return { explanation, script };
  };

  const first = await ask([{ role: 'user', content: prompt.user }]);
  let out = sanitize(first.data);
  if (!out.explanation) throw new AiError('INVALID_OUTPUT', 'The model returned an empty answer');

  if (n.mode === 'explain') {
    return { mode: 'explain', deterministic: false, usedModel: true, explanation: out.explanation, warnings, retried: false, usage };
  }
  if (!out.script) throw new AiError('INVALID_OUTPUT', 'The model did not return a script');

  let verdict = await validateScript(out.script);
  let retried = false;
  // A problem that is not about the script (busy, cancelled, unavailable) is not something the model can fix.
  if (!verdict.ok && !verdict.infra) {
    retried = true;
    try {
      const second = await ask([
        { role: 'user', content: prompt.user },
        { role: 'assistant', content: JSON.stringify({ explanation: out.explanation, script: out.script }) },
        { role: 'user', content: `Your script failed validation: ${verdict.reason}. Return the complete corrected script. Use only the documented apx API.` },
      ]);
      const retry = sanitize(second.data);
      if (retry.script) {
        out = { explanation: retry.explanation || out.explanation, script: retry.script };
        verdict = await validateScript(out.script);
      }
    } catch (err) {
      if (err instanceof AiError && (err.code === 'ABORTED' || err.code === 'AUTH' || err.code === 'RATE_LIMIT')) throw err;
      // The retry is best effort: keep the first answer, flagged as not validated.
    }
  }

  const flags = flagsOf(out.script);
  const validation = { validated: verdict.ok && verdict.executed === true, executed: verdict.ok && verdict.executed === true, errors: [], flags };
  if (!verdict.ok) validation.errors.push({ reason: verdict.reason });
  if (verdict.ok && !verdict.executed) warnings.push('The script was NOT executed: this build cannot run it in an isolated process. It passed the security screen and a syntax check only.');

  let script = out.script;
  if (verdict.refused) {
    // Refused by the screen: never offered. For convert, the deterministic conversion (the user's own code) is the fallback.
    validation.refused = verdict.reason;
    if (n.mode === 'convert') {
      script = workScript;
      warnings.push('The model\'s rewrite was refused for security reasons; the automatic conversion is offered instead, not validated, with the unsupported members still to fix.');
    } else {
      script = undefined;
      warnings.push('The generated script was refused for security reasons and removed from the proposal.');
    }
    validation.validated = false;
    validation.executed = false;
  } else if (!verdict.ok) {
    warnings.push('The script could not be validated: review it carefully before applying it.');
  }
  // Shape-only: the model rewrote a masked copy. Its answer is diffed against the real script by the UI and says so;
  // a placeholder left in it means a value was lost, so it can never count as validated.
  const maskedInput = shapeOnly && workScript.trim().length > 0 && maskScriptLiterals(workScript) !== workScript;
  if (script && maskedInput) {
    warnings.push('Shape-only mode: the model only saw your script with string and number values replaced by placeholders. Compare the diff carefully: values it could not see may be lost or invented.');
    if (/<(?:string|number|regex)>/.test(script)) {
      warnings.push('The proposal contains placeholders (<string>, <number>, <regex>) where your values were: fill them in before using it.');
      validation.validated = false;
    }
  }
  if (script && scrubTokenPatterns(script) !== script) warnings.push('The script contains something that looks like a credential: replace it with a variable.');

  return {
    mode: n.mode, deterministic: false, usedModel: true, explanation: out.explanation,
    ...(script ? { script } : {}), ...(converted ? { converted } : {}),
    validation, maskedInput, warnings: [...new Set(warnings)].slice(0, 10), retried, usage,
  };
}

module.exports = { scriptAssist, describeScriptAssist, normalizeInput, validateScript, flagsOf, KINDS };
