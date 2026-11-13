'use strict';

/**
 * Egress allow-list enforced at the socket layer (net.Socket.prototype.connect).
 *
 * Because it sits below axios/http/tls it covers EVERY outgoing connection made by this process:
 * the request itself (after {{variables}} are resolved), each redirect hop, pm.sendRequest() calls
 * from scripts, OAuth token calls, and connections to a proxy. IPC/unix sockets are refused while the
 * guard is active. The check is on the host NAME used to connect, before DNS resolution: it does not
 * defend against an allowed name that resolves to an unexpected address (DNS rebinding).
 */

const net = require('node:net');

function normalizeHost(h) {
  let x = String(h == null ? '' : h).trim().toLowerCase();
  if (x.startsWith('[') && x.endsWith(']')) x = x.slice(1, -1);
  if (x.endsWith('.')) x = x.slice(0, -1);
  return x;
}

function parsePattern(raw) {
  const p = String(raw).trim().toLowerCase();
  let host = p;
  let port = null;
  const br = /^\[([^\]]+)\](?::(\d+))?$/.exec(p);
  if (br) {
    host = br[1];
    port = br[2] || null;
  } else if ((p.match(/:/g) || []).length === 1) {
    [host, port] = p.split(':');
  }
  const wildcard = host.startsWith('*.');
  if (wildcard) host = host.slice(2);
  if (host.endsWith('.')) host = host.slice(0, -1); // "localhost." is "localhost", as in normalizeHost
  return { host, wildcard, port: port === null || port === '' ? null : Number(port) };
}

function isAllowed(patterns, host, port) {
  const h = normalizeHost(host);
  if (!h) return false;
  return patterns.some((p) => {
    if (p.port !== null && Number(port) !== p.port) return false;
    return p.wildcard ? h.endsWith(`.${p.host}`) : h === p.host;
  });
}

function extractTarget(args) {
  let a0 = args[0];
  if (Array.isArray(a0)) a0 = a0[0]; // node's internal normalized form: [options, cb]
  if (a0 && typeof a0 === 'object') {
    if (a0.path) return { ipc: true };
    return { host: a0.host || 'localhost', port: a0.port };
  }
  if (typeof a0 === 'string' && Number.isNaN(Number(a0))) return { ipc: true };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a0) };
}

/**
 * Several parties hook net.Socket.prototype.connect (the host guard for the whole session, a socket tracker
 * for each run). They are kept in a registry behind one dispatcher, so they can be removed in ANY order and the
 * original connect is restored only when the last one is gone.
 */
const hooks = []; // { fn(socket, args) -> Error|undefined }
let originalConnect = null;

function dispatcher(...args) {
  for (const h of hooks.slice()) {
    const err = h.fn(this, args);
    if (err) {
      process.nextTick(() => this.destroy(err));
      return this;
    }
  }
  return originalConnect.apply(this, args);
}

function addHook(fn) {
  if (hooks.length === 0) {
    originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = dispatcher;
  }
  const hook = { fn };
  hooks.push(hook);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    hooks.splice(hooks.indexOf(hook), 1);
    if (hooks.length === 0) {
      if (net.Socket.prototype.connect === dispatcher) net.Socket.prototype.connect = originalConnect;
      originalConnect = null;
    }
  };
}

const MAX_DENIED_KEPT = 100;

/**
 * @param {string[]} hostPatterns "host", "*.domain" or "host:port"
 * @returns {{ uninstall: () => void, denied: string[] }} `denied` keeps the first 100 labels only
 */
function installHostGuard(hostPatterns, { onDeny } = {}) {
  const patterns = hostPatterns.map(parsePattern);
  const denied = [];
  const remove = addHook((socket, args) => {
    const t = extractTarget(args);
    if (!t.ipc && isAllowed(patterns, t.host, t.port)) return undefined;
    const label = t.ipc ? 'local socket' : normalizeHost(t.host).slice(0, 120);
    if (denied.length < MAX_DENIED_KEPT) denied.push(label);
    if (typeof onDeny === 'function') onDeny(label);
    const err = new Error(`Blocked by --allow-host: connections to "${label}" are not allowed`);
    err.code = 'EAPILIXHOSTDENIED';
    return err;
  });
  return { denied, uninstall: remove };
}

/**
 * Remember every socket opened while active so a stuck run can be torn down (destroyAll) without waiting
 * for the remote side. Sockets are forgotten when they close.
 */
function trackSockets() {
  const sockets = new Set();
  const remove = addHook((socket) => {
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    return undefined;
  });
  return {
    get size() { return sockets.size; },
    destroyAll() { for (const s of [...sockets]) { try { s.destroy(new Error('Run aborted')); } catch { /* already gone */ } } },
    stop: remove,
  };
}

module.exports = { installHostGuard, trackSockets, isAllowed, parsePattern, normalizeHost };
