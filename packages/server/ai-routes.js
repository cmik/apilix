'use strict';

/**
 * /api/ai/* — AI foundation routes (config, test, preview).
 *
 * Security model:
 *  - loopback clients only: a network-exposed Apilix must not become an open proxy
 *    that spends the user's API key, nor let a third party repoint `baseUrl`;
 *  - config + key live in memory only (pushed by the client via PUT /config);
 *  - the key is never returned, logged, or written to ai-log.jsonl;
 *  - 2 MB body limit (the app-wide 50 MB parser is skipped for this prefix).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { AiError, httpStatusFor, buildPreviewContext, getPrompt, describeDocs, isValidLanguage, suggestAssertions, generateRequest, explainFailure, describeExplainEvidence } = require('@apilix/ai');
const { buildDocModel } = require('@apilix/core/docs');

const PROVIDERS = ['anthropic', 'openai-compat'];
const FEATURE_KEYS = ['nlGenerate', 'assertSuggest', 'diagnose', 'scriptAssist', 'docDescribe', 'dataGen', 'smartImport'];
const DEFAULT_BASES = { anthropic: 'https://api.anthropic.com', 'openai-compat': 'https://api.openai.com/v1' };
const MAX_LOG_ENTRIES = 200;
// Routes that dry-run model-written scripts (child processes): global sliding-window cap on top of the
// one-request-at-a-time lock. 12 per minute is far above human use (one click = one call).
const DEFAULT_SCRIPT_RATE = { max: 12, windowMs: 60 * 1000 };
// A response body above this is not analysed (it would also be dry-run in full).
const MAX_SUGGEST_BODY_CHARS = 900000;

// A same-host reverse proxy makes remote clients look like loopback. Proxies announce
// themselves with these headers (Apilix itself never sits behind one when run locally).
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via'];

function loopbackOnly(req, res, next) {
  const headers = req.headers || {};
  if (PROXY_HEADERS.some(h => headers[h] !== undefined)) {
    return res.status(403).json({ error: 'Forbidden: loopback only', code: 'FORBIDDEN' });
  }
  const addr = req.socket && req.socket.remoteAddress;
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'Forbidden: loopback only', code: 'FORBIDDEN' });
}

function sendError(res, err) {
  if (err instanceof AiError) {
    return res.status(err.status || httpStatusFor(err.code)).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/**
 * Validate and normalise AiSettings coming from the client.
 * @returns {{ settings?: object, error?: string }}
 */
function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'settings must be an object' };
  if (typeof input.enabled !== 'boolean') return { error: 'settings.enabled must be a boolean' };
  if (!PROVIDERS.includes(input.provider)) return { error: `settings.provider must be one of ${PROVIDERS.join(', ')}` };
  if (typeof input.model !== 'string' || input.model.length > 200) return { error: 'settings.model must be a string (max 200 chars)' };
  let baseUrl;
  if (input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl !== '') {
    if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2000 || !isHttpUrl(input.baseUrl)) {
      return { error: 'settings.baseUrl must be an http(s) URL' };
    }
    baseUrl = input.baseUrl.trim();
  }
  const max = input.maxContextTokens === undefined ? 8000 : input.maxContextTokens;
  if (!Number.isInteger(max) || max < 500 || max > 200000) return { error: 'settings.maxContextTokens must be an integer between 500 and 200000' };
  const redactSecrets = input.redactSecrets === undefined ? true : input.redactSecrets;
  const sendResponseBodies = input.sendResponseBodies === undefined ? true : input.sendResponseBodies;
  if (typeof redactSecrets !== 'boolean' || typeof sendResponseBodies !== 'boolean') {
    return { error: 'settings.redactSecrets and settings.sendResponseBodies must be booleans' };
  }
  const features = {};
  for (const k of FEATURE_KEYS) features[k] = !!(input.features && input.features[k] === true);
  let outputLanguage;
  if (input.outputLanguage !== undefined && input.outputLanguage !== null && input.outputLanguage !== '') {
    if (!isValidLanguage(input.outputLanguage)) return { error: 'settings.outputLanguage must be a language name (letters, spaces, parentheses, hyphens; max 40)' };
    outputLanguage = input.outputLanguage;
  }
  return {
    settings: {
      enabled: input.enabled,
      provider: input.provider,
      model: input.model.trim(),
      ...(baseUrl ? { baseUrl } : {}),
      maxContextTokens: max,
      redactSecrets,
      sendResponseBodies,
      features,
      ...(outputLanguage ? { outputLanguage } : {}),
    },
  };
}

/**
 * @param {{
 *   getTransport?: (targetUrl: string) => object,
 *   dataDir?: string,
 *   createProviderImpl?: Function,
 *   logger?: { error: Function },
 * }} deps
 */
function createAiRouter(deps = {}) {
  const {
    getTransport = () => ({}),
    dataDir,
    createProviderImpl = require('@apilix/ai').createProvider,
    logger = console,
    scriptRate = DEFAULT_SCRIPT_RATE,
    now = Date.now,
  } = deps;

  /** @type {{ settings: object, apiKey: string } | null} */
  let config = null;
  const memoryLog = [];
  const busy = new Set();
  const scriptCalls = []; // timestamps of admitted calls on routes that dry-run scripts

  function logCall(entry) {
    const line = { ts: new Date().toISOString(), ...entry };
    memoryLog.push(line);
    if (memoryLog.length > MAX_LOG_ENTRIES) memoryLog.shift();
    if (!dataDir) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(path.join(dataDir, 'ai-log.jsonl'), `${JSON.stringify(line)}\n`);
    } catch { /* logging must never break a request */ }
  }

  const router = express.Router();
  router.use(loopbackOnly);
  router.use(express.json({ limit: '2mb' }));

  router.put('/config', (req, res) => {
    const body = req.body || {};
    const v = validateSettings(body.settings);
    if (v.error) return res.status(400).json({ error: v.error, code: 'BAD_REQUEST' });
    const { apiKey } = body;
    if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== 'string' || apiKey.length > 500)) {
      return res.status(400).json({ error: 'apiKey must be a string (max 500 chars)', code: 'BAD_REQUEST' });
    }
    let key = config ? config.apiKey : '';
    if (typeof apiKey === 'string') key = apiKey.trim();
    else if (apiKey === null) key = '';
    // A stored key must never follow a change of destination.
    if (apiKey === undefined && config) {
      const prev = config.settings;
      if (prev.provider !== v.settings.provider || (prev.baseUrl || '') !== (v.settings.baseUrl || '')) key = '';
    }
    config = { settings: v.settings, apiKey: key };
    return res.json({ ok: true, hasKey: key.length > 0 });
  });

  router.delete('/config', (_req, res) => {
    config = null;
    res.json({ ok: true });
  });

  /**
   * Run one AI call under the shared guards: enabled + key, one request at a time,
   * abort on client disconnect, uniform logging and error mapping.
   * `fn({ provider, settings, signal })` returns { body, usage?, model?, latencyMs? }.
   */
  async function runAiCall(req, res, feature, fn, { featureFlag, rateLimited = false } = {}) {
    if (!config || !config.settings.enabled) {
      return sendError(res, new AiError('DISABLED', 'AI features are disabled'));
    }
    const { settings, apiKey } = config;
    if (featureFlag && settings.features[featureFlag] !== true) {
      return sendError(res, new AiError('DISABLED', 'This AI feature is disabled in the AI settings'));
    }
    // One in-flight AI call per router. The key must NOT contain anything the caller controls (an
    // x-apilix-client header would let a client open as many parallel calls as it likes); loopbackOnly has
    // already restricted callers to this machine, so there is a single key.
    const lockKey = 'loopback';
    if (busy.has(lockKey)) return res.status(429).json({ error: 'Another AI request is already running', code: 'RATE_LIMIT' });
    if (rateLimited) {
      const t = now();
      while (scriptCalls.length && t - scriptCalls[0] >= scriptRate.windowMs) scriptCalls.shift();
      if (scriptCalls.length >= scriptRate.max) {
        return res.status(429).json({ error: 'Too many AI requests in a short time, wait a moment', code: 'RATE_LIMIT' });
      }
      scriptCalls.push(t);
    }
    busy.add(lockKey);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      if (settings.provider === 'anthropic' && !apiKey) throw new AiError('NO_PROVIDER', 'No API key is configured');
      const provider = createProviderImpl(
        { kind: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey },
        getTransport(settings.baseUrl || DEFAULT_BASES[settings.provider]),
      );
      const r = await fn({ provider, settings, signal: ac.signal });
      const usage = r.usage || { inputTokens: 0, outputTokens: 0 };
      logCall({ feature, model: r.model || settings.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: r.latencyMs, ok: true });
      return res.json(r.body);
    } catch (err) {
      const code = err instanceof AiError ? err.code : err && err.code === 'BAD_REQUEST' ? 'BAD_REQUEST' : 'INTERNAL';
      logCall({ feature, model: settings.model, ok: false, code });
      if (err && err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message, code: 'BAD_REQUEST' });
      if (!(err instanceof AiError)) logger.error('AI route error:', code);
      return sendError(res, err);
    } finally {
      busy.delete(lockKey);
    }
  }

  router.post('/test', (req, res) => runAiCall(req, res, 'test', async ({ provider, signal }) => {
    const prompt = getPrompt('connectionTest');
    const r = await provider.complete({
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      schema: 'connectionTest',
      signal,
      maxTokens: 64,
    });
    return { body: { ok: true, model: r.model, latencyMs: r.latencyMs }, usage: r.usage, model: r.model, latencyMs: r.latencyMs };
  }));

  router.post('/describe-docs', (req, res) => runAiCall(req, res, 'docDescribe', async ({ provider, settings, signal }) => {
    const { collection, folder, language, secretValues } = req.body || {};
    if (!collection || typeof collection !== 'object' || !collection.info || !Array.isArray(collection.item)) throw bad('collection must contain info and item[]');
    if (folder !== undefined && typeof folder !== 'string') throw bad('folder must be a string');
    if (language !== undefined && language !== null && language !== '' && !isValidLanguage(language)) throw bad('language must be a language name (letters, spaces, parentheses, hyphens; max 40)');
    if (secretValues !== undefined && !Array.isArray(secretValues)) throw bad('secretValues must be an array');
    let model;
    try {
      model = buildDocModel(collection, { folder: folder || undefined, includeCredentials: false, includeExamples: true });
    } catch (e) {
      throw bad(e.message);
    }
    const started = Date.now();
    const r = await describeDocs({
      provider,
      model,
      language: language ? language.trim() : settings.outputLanguage,
      maxContextTokens: settings.maxContextTokens,
      redactSecrets: settings.redactSecrets,
      secretValues: (secretValues || []).slice(0, 1000).filter(x => typeof x === 'string'),
      signal,
    });
    return { body: { descriptions: r.descriptions, warnings: r.warnings, requested: r.requested }, usage: r.usage, latencyMs: Date.now() - started };
  }, { featureFlag: 'docDescribe' }));

  const bad = (m) => Object.assign(new Error(m), { code: 'BAD_REQUEST' });
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const checkLanguage = (language) => {
    if (language !== undefined && language !== null && language !== '' && !isValidLanguage(language)) {
      throw bad('language must be a language name (letters, spaces, parentheses, hyphens; max 40)');
    }
  };
  const secretList = (v) => {
    if (v !== undefined && !Array.isArray(v)) throw bad('secretValues must be an array');
    return (v || []).slice(0, 1000).filter(x => typeof x === 'string');
  };

  router.post('/suggest-assertions', (req, res) => runAiCall(req, res, 'assertSuggest', async ({ provider, settings, signal }) => {
    const { request, name, response, existingTests, language, secretValues } = req.body || {};
    if (!isObj(response) || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw bad('response must be an object with an integer status');
    if (response.body !== undefined && typeof response.body !== 'string') throw bad('response.body must be a string');
    if ((response.body || '').length > MAX_SUGGEST_BODY_CHARS) throw bad('response.body is too large to analyse');
    if (response.headers !== undefined && !isObj(response.headers)) throw bad('response.headers must be an object');
    if (request !== undefined && !isObj(request)) throw bad('request must be an object');
    if (name !== undefined && typeof name !== 'string') throw bad('name must be a string');
    if (existingTests !== undefined && typeof existingTests !== 'string') throw bad('existingTests must be a string');
    checkLanguage(language);
    const secrets = secretList(secretValues);
    const r = await suggestAssertions({
      provider,
      request,
      name,
      response,
      existingTests: (existingTests || '').slice(0, 20000),
      maxContextTokens: settings.maxContextTokens,
      redactSecrets: settings.redactSecrets,
      sendResponseBodies: settings.sendResponseBodies,
      secretValues: secrets,
      language: language ? language.trim() : settings.outputLanguage,
      signal,
    });
    return {
      body: { suggestions: r.suggestions, executed: r.executed, discarded: r.discarded, discardedCount: r.discardedCount, truncated: r.truncated, shapeOnly: r.shapeOnly },
      usage: r.usage, model: r.model, latencyMs: r.latencyMs,
    };
  }, { featureFlag: 'assertSuggest', rateLimited: true }));

  // Explain failed assertions. Feature flag: `diagnose` ("Explain and diagnose failures" in the AI settings).
  // The answer is text for display only: nothing is executed or applied.
  // Not rate limited: no script dry-run runs here, the global lock allows one model call at a time, and the server is loopback-only.
  router.post('/explain-failure', (req, res) => runAiCall(req, res, 'diagnose', async ({ provider, settings, signal }) => {
    const { request, name, response, failures, testScript, variableNames, language, secretValues } = req.body || {};
    if (!isObj(response) || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw bad('response must be an object with an integer status');
    if (response.body !== undefined && typeof response.body !== 'string') throw bad('response.body must be a string');
    if ((response.body || '').length > MAX_SUGGEST_BODY_CHARS) throw bad('response.body is too large to analyse');
    if (response.headers !== undefined && !isObj(response.headers)) throw bad('response.headers must be an object');
    if (request !== undefined && !isObj(request)) throw bad('request must be an object');
    if (name !== undefined && typeof name !== 'string') throw bad('name must be a string');
    if (!Array.isArray(failures) || !failures.some(f => isObj(f) && typeof f.name === 'string')) throw bad('failures must list at least one failed assertion');
    if (testScript !== undefined && typeof testScript !== 'string') throw bad('testScript must be a string');
    if (variableNames !== undefined && !Array.isArray(variableNames)) throw bad('variableNames must be an array');
    checkLanguage(language);
    const r = await explainFailure({
      provider,
      request,
      name,
      response,
      failures: failures.slice(0, 50),
      testScript: (testScript || '').slice(0, 20000),
      variableNames: (variableNames || []).slice(0, 500),
      maxContextTokens: settings.maxContextTokens,
      redactSecrets: settings.redactSecrets,
      sendResponseBodies: settings.sendResponseBodies,
      secretValues: secretList(secretValues),
      language: language ? language.trim() : settings.outputLanguage,
      signal,
    });
    return {
      body: { summary: r.summary, likelyCauses: r.likelyCauses, suggestedFixes: r.suggestedFixes, truncated: r.truncated, shapeOnly: r.shapeOnly },
      usage: r.usage, model: r.model, latencyMs: r.latencyMs,
    };
  }, { featureFlag: 'diagnose' }));

  router.post('/generate-request', (req, res) => runAiCall(req, res, 'nlGenerate', async ({ provider, settings, signal }) => {
    const { instruction, current, neighbors, variables, language, secretValues } = req.body || {};
    if (typeof instruction !== 'string' || !instruction.trim()) throw bad('instruction must be a non-empty string');
    if (instruction.length > 5000) throw bad('instruction is too long');
    if (current !== undefined && !(isObj(current) && isObj(current.request))) throw bad('current must be a request item');
    if (neighbors !== undefined && !Array.isArray(neighbors)) throw bad('neighbors must be an array');
    if (variables !== undefined && !Array.isArray(variables)) throw bad('variables must be an array');
    checkLanguage(language);
    const started = Date.now();
    const r = await generateRequest({
      provider,
      instruction,
      current,
      neighbors: (neighbors || []).filter(n => isObj(n) && isObj(n.request)).slice(0, 10),
      variables: (variables || []).slice(0, 1000).filter(v => isObj(v) && typeof v.name === 'string'),
      maxContextTokens: settings.maxContextTokens,
      redactSecrets: settings.redactSecrets,
      secretValues: secretList(secretValues),
      language: language ? language.trim() : settings.outputLanguage,
      signal,
    });
    return { body: { draft: r.draft, validation: r.validation, warnings: r.warnings, retried: r.retried }, usage: r.usage, latencyMs: Date.now() - started };
  }, { featureFlag: 'nlGenerate', rateLimited: true }));

  router.post('/preview', (req, res) => {
    const { item, response, variables, secretValues, settings, explain } = req.body || {};
    if ((item !== undefined && (typeof item !== 'object' || item === null))
      || (response !== undefined && (typeof response !== 'object' || response === null))) {
      return res.status(400).json({ error: 'item and response must be objects', code: 'BAD_REQUEST' });
    }
    if ((variables !== undefined && !Array.isArray(variables)) || (secretValues !== undefined && !Array.isArray(secretValues))) {
      return res.status(400).json({ error: 'variables and secretValues must be arrays', code: 'BAD_REQUEST' });
    }
    const base = (config && config.settings) || {};
    const override = settings && typeof settings === 'object' ? settings : {};
    const merged = {
      maxContextTokens: Number.isInteger(override.maxContextTokens) ? override.maxContextTokens : base.maxContextTokens,
      redactSecrets: typeof override.redactSecrets === 'boolean' ? override.redactSecrets : base.redactSecrets,
      sendResponseBodies: typeof override.sendResponseBodies === 'boolean' ? override.sendResponseBodies : base.sendResponseBodies,
    };
    const variablesMeta = (variables || []).slice(0, 500)
      .filter(v => v && typeof v.name === 'string')
      .map(v => ({ name: v.name.slice(0, 200), scope: typeof v.scope === 'string' ? v.scope.slice(0, 40) : undefined, secret: v.secret === true }));
    const secrets = (secretValues || []).slice(0, 1000).filter(s => typeof s === 'string');
    try {
      const preview = buildPreviewContext({ item, response, variablesMeta, secretValues: secrets, settings: merged });
      if (explain && typeof explain === 'object' && Array.isArray(explain.failures)) {
        // Explain failures: also show the failure messages, test script and variable names exactly as they would be sent.
        const extra = describeExplainEvidence({
          request: item && item.request,
          name: item && typeof item.name === 'string' ? item.name : undefined,
          response,
          failures: explain.failures.slice(0, 50),
          testScript: typeof explain.testScript === 'string' ? explain.testScript.slice(0, 20000) : '',
          variableNames: Array.isArray(explain.variableNames) ? explain.variableNames.slice(0, 500) : [],
          secretValues: secrets,
          redactSecrets: merged.redactSecrets,
          sendResponseBodies: merged.sendResponseBodies,
        });
        // The explain sections already show the request and the response status/headers as they are sent
        // (shape-only reduces headers to names), so the generic versions would be misleading.
        const generic = new Set(['Request', 'Response (status and headers)']);
        preview.sections = [...extra, ...preview.sections.filter(sec => !generic.has(sec.label))];
        preview.estimatedTokens = preview.sections.reduce((n, sec) => n + Math.ceil(sec.text.length / 4), 0);
      }
      return res.json(preview);
    } catch (err) {
      logger.error('AI preview error:', err && err.name);
      return res.status(500).json({ error: 'Could not build the preview', code: 'INTERNAL' });
    }
  });

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'AI request body is too large (limit 2 MB)', code: 'TOO_LARGE' });
    }
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' });
    }
    logger.error('AI router error:', err && err.name);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
  });

  /** Test hooks: never exposes the key. */
  router.getLog = () => [...memoryLog];
  router.hasKey = () => !!(config && config.apiKey);
  return router;
}

/**
 * True for /api/ai and /api/ai/*, case-insensitively: Express routes are
 * case-insensitive, so a case-sensitive check would let /API/AI/* skip the 2 MB parser.
 */
function isAiPath(p) {
  return /^\/api\/ai(\/|$)/i.test(String(p || ''));
}

module.exports = { createAiRouter, loopbackOnly, validateSettings, isAiPath };
