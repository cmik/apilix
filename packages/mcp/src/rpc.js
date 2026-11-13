'use strict';

/**
 * Minimal MCP transport: newline-delimited JSON-RPC 2.0 over stdio.
 *
 * Why not @modelcontextprotocol/sdk: it is ESM-only, pulls ~13 extra packages
 * (express, hono, jose, zod ...) and does not bundle with `pkg` (see wiki/MCP-Server.md).
 *
 * Rules enforced here:
 *  - stdout carries JSON-RPC messages only (one per line); everything else goes to stderr.
 *  - a line longer than maxLineBytes is discarded and answered with -32600 (id null).
 *  - notifications (no "id") never get a response, not even an error.
 *  - batches are rejected (removed from the MCP spec in 2025-06-18).
 */

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

const CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32002,
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {object} opts
 * @param {{name:string, version:string}} opts.serverInfo
 * @param {string} [opts.instructions]
 * @param {object} [opts.capabilities] advertised in `initialize`
 * @param {Record<string, (params:any, ctx:{signal:AbortSignal, id:string|number}) => Promise<any>|any>} opts.methods request handlers
 * @param {number} [opts.maxLineBytes]
 * @param {(value:any) => any} [opts.scrub] applied to every outgoing result/error payload (never to the id)
 * @param {(msg:string) => void} [opts.log] diagnostics, must write to stderr only
 */
function createRpcServer(opts) {
  const methods = opts.methods || {};
  const maxLineBytes = opts.maxLineBytes || DEFAULT_MAX_LINE_BYTES;
  const scrub = typeof opts.scrub === 'function' ? opts.scrub : v => v;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const inflight = new Map(); // id -> AbortController
  const shutdownCtl = new AbortController(); // aborted at EOF / stop(): long operations must give up (responses still go out)
  const DRAIN_MS = 5000;
  const pending = new Set();
  let initialized = false;
  let out = null;
  let closed = false;
  let stopFn = null;

  function send(message) {
    if (closed || !out) return;
    out.write(`${JSON.stringify(message)}\n`);
  }

  function respond(id, result) {
    send({ jsonrpc: '2.0', id, result: scrub(result) });
  }

  function respondError(id, code, message, data) {
    const error = { code, message: scrub(String(message)) };
    if (data !== undefined) error.data = scrub(data);
    send({ jsonrpc: '2.0', id, error });
  }

  function handleInitialize(params) {
    if (initialized) throw new RpcError(CODES.INVALID_REQUEST, 'Already initialized');
    if (!isPlainObject(params) || typeof params.protocolVersion !== 'string') {
      throw new RpcError(CODES.INVALID_PARAMS, 'initialize requires params.protocolVersion (string)');
    }
    if (params.capabilities !== undefined && !isPlainObject(params.capabilities)) {
      throw new RpcError(CODES.INVALID_PARAMS, 'params.capabilities must be an object');
    }
    initialized = true;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(params.protocolVersion)
      ? params.protocolVersion
      : SUPPORTED_PROTOCOLS[0];
    const result = {
      protocolVersion,
      capabilities: opts.capabilities || {},
      serverInfo: opts.serverInfo,
    };
    if (opts.instructions) result.instructions = opts.instructions;
    return result;
  }

  async function handleRequest(id, method, params) {
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      let result;
      if (method === 'initialize') {
        result = handleInitialize(params);
      } else if (method === 'ping') {
        result = {};
      } else {
        if (!initialized) throw new RpcError(CODES.NOT_INITIALIZED, 'Server not initialized: send "initialize" first');
        const handler = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : null;
        if (!handler) throw new RpcError(CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
        result = await handler(params, { signal: controller.signal, shutdown: shutdownCtl.signal, id });
      }
      if (controller.signal.aborted) return; // cancelled: the spec says no response
      respond(id, result === undefined ? {} : result);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof RpcError) {
        respondError(id, err.code, err.message, err.data);
      } else {
        log(`internal error in "${method}": ${err && err.message ? err.message : err}`);
        respondError(id, CODES.INTERNAL_ERROR, 'Internal error');
      }
    } finally {
      inflight.delete(id);
    }
  }

  function handleNotification(method, params) {
    if (method === 'notifications/cancelled' && isPlainObject(params)) {
      const ctrl = inflight.get(params.requestId);
      if (ctrl) ctrl.abort();
    }
    // notifications/initialized and unknown notifications are ignored by design.
  }

  function handleLine(line) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.trim() === '') return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      respondError(null, CODES.PARSE_ERROR, 'Parse error');
      return;
    }
    if (Array.isArray(msg)) {
      respondError(null, CODES.INVALID_REQUEST, 'Batch requests are not supported');
      return;
    }
    if (!isPlainObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // A response from the client (has result/error) is ignored: we never send requests.
      if (isPlainObject(msg) && msg.jsonrpc === '2.0' && ('result' in msg || 'error' in msg)) return;
      const id = isPlainObject(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
      respondError(id, CODES.INVALID_REQUEST, 'Invalid Request: expected {"jsonrpc":"2.0","method":string,...}');
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    if (!hasId) {
      handleNotification(msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== 'string' && typeof msg.id !== 'number') {
      respondError(null, CODES.INVALID_REQUEST, 'Invalid Request: id must be a string or a number');
      return;
    }
    if (msg.params !== undefined && !isPlainObject(msg.params) && !Array.isArray(msg.params)) {
      respondError(msg.id, CODES.INVALID_PARAMS, 'params must be an object');
      return;
    }
    const p = handleRequest(msg.id, msg.method, msg.params);
    pending.add(p);
    p.finally(() => pending.delete(p));
  }

  /**
   * Read newline-delimited messages from `input` and write responses to `output`.
   * Resolves once input ended (or stop() was called) and all in-flight requests completed.
   */
  function serve(input, output) {
    out = output;
    return new Promise((resolve) => {
      let draining = null;
      /** Abort everything still running, then wait (bounded) for the handlers to wind down. */
      const drain = () => {
        if (draining) return draining;
        shutdownCtl.abort();
        draining = (async () => {
          let timer;
          const limit = new Promise((r) => { timer = setTimeout(r, DRAIN_MS); });
          await Promise.race([(async () => { while (pending.size > 0) await Promise.allSettled([...pending]); })(), limit]);
          clearTimeout(timer);
          closed = true;
          resolve();
        })();
        return draining;
      };
      stopFn = drain;

      let chunks = [];
      let size = 0;
      let discarding = false;

      const finishLine = () => {
        if (discarding) {
          discarding = false;
          chunks = [];
          size = 0;
          respondError(null, CODES.INVALID_REQUEST, `Message too large (limit ${maxLineBytes} bytes)`);
          return;
        }
        const line = Buffer.concat(chunks).toString('utf8');
        chunks = [];
        size = 0;
        handleLine(line);
      };

      input.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        while (start < buf.length) {
          const nl = buf.indexOf(10, start);
          const end = nl === -1 ? buf.length : nl;
          if (!discarding) {
            size += end - start;
            if (size > maxLineBytes) {
              discarding = true;
              chunks = [];
            } else {
              chunks.push(buf.subarray(start, end));
            }
          }
          if (nl === -1) break;
          finishLine();
          start = nl + 1;
        }
      });

      input.on('end', () => {
        if (discarding || size > 0) finishLine();
        // EOF: the client is gone. Tell long-running operations to stop, then wait (bounded) for them.
        drain();
      });
      input.on('error', (err) => {
        log(`stdin error: ${err && err.message}`);
        drain();
      });
      if (output && typeof output.on === 'function') {
        // A closed pipe (EPIPE) must end the session cleanly instead of crashing with an uncaught error.
        output.on('error', (err) => {
          log(`stdout error: ${err && err.code ? err.code : err && err.message}`);
          closed = true;
          drain();
        });
      }
    });
  }

  /** Stop serving: abort long operations and resolve serve() once they wound down (signals, broken pipe). */
  const stop = () => (stopFn ? stopFn() : Promise.resolve());
  return { serve, handleLine, stop, CODES };
}

module.exports = { createRpcServer, RpcError, CODES, SUPPORTED_PROTOCOLS, DEFAULT_MAX_LINE_BYTES };
