'use strict';

const { AiError } = require('./errors');
const { validateOutput } = require('./validate');
const schemas = require('./schemas');
const anthropic = require('./providers/anthropic');
const openaiCompat = require('./providers/openai-compat');

const IMPLS = { anthropic, 'openai-compat': openaiCompat };
const DEFAULT_TIMEOUT_MS = 60000;

function scrubKey(err, apiKey) {
  if (apiKey && apiKey.length >= 4 && typeof err.message === 'string' && err.message.includes(apiKey)) {
    err.message = err.message.split(apiKey).join('<redacted>');
  }
  return err;
}

/**
 * Create a provider. Pure: no disk access, config is injected.
 * @param {{ kind: 'anthropic'|'openai-compat', baseUrl?: string, model: string, apiKey?: string, timeoutMs?: number }} config
 * @param {{ httpAgent?: any, httpsAgent?: any, proxy?: any, axiosInstance?: any }} [transport]
 */
function createProvider(config, transport = {}) {
  const impl = config && IMPLS[config.kind];
  if (!impl) throw new AiError('NO_PROVIDER', 'No AI provider is configured');
  if (!config.model) throw new AiError('NO_PROVIDER', 'No AI model is configured');
  const cfg = { ...config, timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS };

  /**
   * @param {{ system?: string, messages: Array<{role:'user'|'assistant', content:string}>,
   *   schema?: object|string, schemaName?: string, signal?: AbortSignal, maxTokens?: number }} req
   * @returns {Promise<{ data: any, usage: {inputTokens:number, outputTokens:number}, model: string, latencyMs: number, retries: number }>}
   */
  async function complete(req) {
    const { system, messages, signal, maxTokens } = req;
    const schemaName = typeof req.schema === 'string' ? req.schema : req.schemaName;
    const schema = typeof req.schema === 'string' ? schemas.get(req.schema) : req.schema;
    if (typeof req.schema === 'string' && !schema) throw new Error(`Unknown schema "${req.schema}"`);
    const started = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0 };
    let msgs = messages;
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try {
        r = await impl.call({ config: cfg, transport, system, messages: msgs, schema, schemaName, signal, maxTokens });
      } catch (err) {
        throw scrubKey(err instanceof AiError ? err : new AiError('NETWORK', 'AI provider call failed'), cfg.apiKey);
      }
      usage.inputTokens += r.usage.inputTokens;
      usage.outputTokens += r.usage.outputTokens;
      const done = (data) => ({ data, usage, model: cfg.model, latencyMs: Date.now() - started, retries: attempt });
      if (!schema) return done(r.text);
      const v = r.data === undefined
        ? { ok: false, formatted: 'The output was not valid JSON' }
        : validateOutput(schema, r.data);
      if (v.ok) return done(r.data);
      if (attempt === 1) {
        throw new AiError('INVALID_OUTPUT', `The model returned output that does not match the expected structure (${v.formatted})`);
      }
      msgs = [
        ...messages,
        { role: 'assistant', content: r.text || '{}' },
        { role: 'user', content: `Your previous answer was invalid: ${v.formatted}. Reply again with the corrected output only.` },
      ];
    }
    throw new AiError('INVALID_OUTPUT', 'The model returned invalid output');
  }

  return { complete, config: { kind: cfg.kind, model: cfg.model, baseUrl: cfg.baseUrl } };
}

module.exports = { createProvider };
