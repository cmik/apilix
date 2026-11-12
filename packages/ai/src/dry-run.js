'use strict';

/**
 * Dry-run model-written scripts in the real Apilix sandbox (@apilix/core/script-runtime), offline.
 *
 * Nothing here is ever applied: the result only says whether a script is fit to be shown. Two modes:
 *  - strict  (assertion suggestions): the script ran on the very response that inspired it, so every
 *            test must pass and a test must exist (a capture must set a variable);
 *  - lenient (generated requests): the response is a stand-in, so assertion mismatches and "cannot
 *            read property of undefined" are expected and tolerated; syntax errors, unknown
 *            identifiers and API misuse are not.
 */

const vm = require('vm');
const { screenScript } = require('./script-screen');

const WALL_CLOCK_MS = 4000;
const SYNC_TIMEOUT_MS = 1500;

// Errors that say "the script itself is wrong" (as opposed to "the stand-in response is not what it expects").
const STRUCTURAL_ERROR_RE = /is not defined|is not a function|is not a constructor|is not iterable|Unexpected (?:token|identifier|end|string|number)|Invalid or unexpected token|Invalid regular expression|Missing initializer|has already been declared|Assignment to constant|Illegal (?:return|break|continue)|await is only valid|offline \(dry-run\) mode|Cannot (?:set|assign|define)|is not allowed in a validated script|Unexpected strict mode|SyntaxError|Script execution timed out|ReferenceError/i;
// On a stand-in response these are expected, not bugs.
const TOLERATED_ERROR_RE = /^(?:AssertionError|expected|Expected|assert)|Cannot read propert|Cannot destructure|of undefined|of null|undefined|is not valid JSON|Unexpected token .* in JSON/;

function buildSandboxResponse(res) {
  const body = typeof res.body === 'string' ? res.body : '';
  let jsonData = body;
  try { jsonData = JSON.parse(body); } catch { /* keep text */ }
  return {
    code: Number.isInteger(res.status) ? res.status : 200,
    status: typeof res.statusText === 'string' ? res.statusText : '',
    responseTime: Number.isFinite(res.responseTime) ? res.responseTime : 100,
    headers: res.headers && typeof res.headers === 'object' ? res.headers : {},
    body,
    jsonData,
  };
}

function parseCheck(code) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(`(async function(){\n'use strict';\n${code}\n})();`, { filename: 'apilix-dry-run.js' });
    return null;
  } catch (e) {
    return `syntax error: ${String(e && e.message).slice(0, 160)}`;
  }
}

function collectVariables(result) {
  const out = {};
  for (const bucket of [result.updatedVariables, result.updatedEnvMutations, result.updatedGlobalMutations, result.updatedCollVarMutations]) {
    for (const [k, v] of Object.entries(bucket || {})) out[k] = v;
  }
  return out;
}

/**
 * @param {string} code
 * @param {{ response: { status?: number, statusText?: string, headers?: object, body?: string, responseTime?: number },
 *           mode?: 'strict'|'lenient', expects?: 'test'|'capture'|'any', variables?: Record<string,string> }} opts
 * @returns {Promise<{ ok: boolean, reason?: string, tests: Array<{name:string, passed:boolean, error?:string}>, variables: Record<string,string> }>}
 */
async function dryRunScript(code, opts = {}) {
  const { response, mode = 'strict', expects = 'any', variables = {} } = opts;
  const fail = (reason, extra = {}) => ({ ok: false, reason, tests: [], variables: {}, ...extra });

  const screened = screenScript(code);
  if (!screened.ok) return fail(screened.reason, { screened: false });
  const syntax = parseCheck(code);
  if (syntax) return fail(syntax);

  // Lazy: @apilix/core is an optional peer of @apilix/ai.
  const { runScript } = require('@apilix/core/script-runtime');
  let timer;
  let result;
  try {
    result = await Promise.race([
      runScript(code, buildSandboxResponse(response || {}), { ...variables }, { offline: true, timeoutMs: SYNC_TIMEOUT_MS, context: {} }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), WALL_CLOCK_MS); }),
    ]);
  } catch (e) {
    return fail(e && e.message === 'timed out' ? 'the script did not finish in time' : 'the script could not be run');
  } finally {
    clearTimeout(timer);
  }

  const tests = (result.tests || []).map(t => ({ name: String(t.name), passed: t.passed === true, ...(t.error ? { error: String(t.error).slice(0, 300) } : {}) }));
  const vars = collectVariables(result);
  const failed = tests.filter(t => !t.passed);

  if (mode === 'lenient') {
    const broken = failed.find(t => STRUCTURAL_ERROR_RE.test(t.error || '') || !TOLERATED_ERROR_RE.test(t.error || ''));
    if (broken) return { ok: false, reason: `${broken.name === '__ScriptError__' ? 'script error' : 'test error'}: ${broken.error || 'failed'}`.slice(0, 240), tests, variables: vars };
    return { ok: true, tests, variables: vars };
  }

  if (failed.length) {
    const f = failed[0];
    return { ok: false, reason: `${f.name === '__ScriptError__' ? 'script error' : `"${f.name}" fails on the response`}: ${f.error || 'failed'}`.slice(0, 240), tests, variables: vars };
  }
  if (expects === 'test' && tests.length === 0) return { ok: false, reason: 'the script registers no test', tests, variables: vars };
  if (expects === 'capture') {
    const values = Object.values(vars);
    if (!values.length || values.every(v => v === 'undefined' || v === 'null' || v === '')) {
      return { ok: false, reason: 'the script does not save a value on this response', tests, variables: vars };
    }
  }
  return { ok: true, tests, variables: vars };
}

module.exports = { dryRunScript, buildSandboxResponse, STRUCTURAL_ERROR_RE };
