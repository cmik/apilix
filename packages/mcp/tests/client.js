'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'src', 'bin.js');

/**
 * Real MCP-style stdio client: spawns the server, speaks JSON-RPC and records stderr.
 * Any non-JSON line on stdout is recorded in `badStdout` (the server must never emit one).
 */
function startServer(args = [], { cwd, env } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...(env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let nextId = 1;
  const waiting = new Map();
  const messages = [];
  const badStdout = [];
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { badStdout.push(line); continue; }
      messages.push(msg);
      if (msg && msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  let exitInfo = null;
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    for (const [, fn] of waiting) fn({ error: { code: -1, message: `server exited (${code}): ${stderr.slice(0, 500)}` } });
    waiting.clear();
    resolve(exitInfo);
  }));

  function request(method, params, { timeoutMs = 60000 } = {}) {
    const id = nextId++;
    if (exitInfo) return Promise.resolve({ error: { code: -1, message: `server exited (${exitInfo.code}): ${stderr.slice(0, 500)}` } });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  /** Send a request without waiting: { id, promise } so the caller can cancel it by id. */
  function start(method, params, opts) {
    const id = nextId;
    return { id, promise: request(method, params, opts) };
  }
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const raw = (s) => child.stdin.write(s);

  async function initialize() {
    const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '0' } });
    notify('notifications/initialized');
    return r;
  }

  /** tools/call; returns { isError, data (parsed JSON) | text }. */
  async function call(name, args = {}, opts) {
    const r = await request('tools/call', { name, arguments: args }, opts);
    if (r.error) return { rpcError: r.error };
    const text = r.result.content.map((c) => c.text).join('');
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { isError: r.result.isError === true, text, data, result: r.result };
  }

  async function close() {
    child.stdin.end();
    const r = await exited;
    return r;
  }

  return { child, request, start, notify, raw, initialize, call, close, exited, messages, badStdout, get stderr() { return stderr; } };
}

module.exports = { startServer, BIN };
