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
const { AiError, httpStatusFor, buildPreviewContext, getPrompt } = require('@apilix/ai');

const PROVIDERS = ['anthropic', 'openai-compat'];
const FEATURE_KEYS = ['nlGenerate', 'assertSuggest', 'diagnose', 'scriptAssist', 'docDescribe', 'dataGen', 'smartImport'];
const DEFAULT_BASES = { anthropic: 'https://api.anthropic.com', 'openai-compat': 'https://api.openai.com/v1' };
const MAX_LOG_ENTRIES = 200;

function loopbackOnly(req, res, next) {
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
    if (typeof input.outputLanguage !== 'string' || input.outputLanguage.length > 40) return { error: 'settings.outputLanguage must be a short string' };
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
  } = deps;

  /** @type {{ settings: object, apiKey: string } | null} */
  let config = null;
  const memoryLog = [];
  const busy = new Set();

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

  router.post('/test', async (req, res) => {
    if (!config || !config.settings.enabled) {
      return sendError(res, new AiError('DISABLED', 'AI features are disabled'));
    }
    const { settings, apiKey } = config;
    const lockKey = `${req.socket.remoteAddress}|${req.get('x-apilix-client') || ''}`;
    if (busy.has(lockKey)) return res.status(429).json({ error: 'Another AI request is already running', code: 'RATE_LIMIT' });
    busy.add(lockKey);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      if (settings.provider === 'anthropic' && !apiKey) throw new AiError('NO_PROVIDER', 'No API key is configured');
      const provider = createProviderImpl(
        { kind: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey },
        getTransport(settings.baseUrl || DEFAULT_BASES[settings.provider]),
      );
      const prompt = getPrompt('connectionTest');
      const r = await provider.complete({
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        schema: 'connectionTest',
        signal: ac.signal,
        maxTokens: 64,
      });
      logCall({ feature: 'test', model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, latencyMs: r.latencyMs, ok: true });
      return res.json({ ok: true, model: r.model, latencyMs: r.latencyMs });
    } catch (err) {
      const code = err instanceof AiError ? err.code : 'INTERNAL';
      logCall({ feature: 'test', model: settings.model, ok: false, code });
      if (!(err instanceof AiError)) logger.error('AI route error:', code);
      return sendError(res, err);
    } finally {
      busy.delete(lockKey);
    }
  });

  router.post('/preview', (req, res) => {
    const { item, response, variables, secretValues, settings } = req.body || {};
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
      return res.json(buildPreviewContext({ item, response, variablesMeta, secretValues: secrets, settings: merged }));
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

module.exports = { createAiRouter, loopbackOnly, validateSettings };
