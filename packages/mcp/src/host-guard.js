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
  return { host: wildcard ? host.slice(2) : host, wildcard, port: port === null || port === '' ? null : Number(port) };
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
 * @param {string[]} hostPatterns "host", "*.domain" or "host:port"
 * @returns {{ uninstall: () => void, denied: string[] }}
 */
function installHostGuard(hostPatterns, { onDeny } = {}) {
  const patterns = hostPatterns.map(parsePattern);
  const original = net.Socket.prototype.connect;
  const denied = [];
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const t = extractTarget(args);
    if (t.ipc || !isAllowed(patterns, t.host, t.port)) {
      const label = t.ipc ? 'local socket' : normalizeHost(t.host).slice(0, 120);
      denied.push(label);
      if (typeof onDeny === 'function') onDeny(label);
      const err = new Error(`Blocked by --allow-host: connections to "${label}" are not allowed`);
      err.code = 'EAPILIXHOSTDENIED';
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return original.apply(this, args);
  };
  return {
    denied,
    uninstall() { net.Socket.prototype.connect = original; },
  };
}

module.exports = { installHostGuard, isAllowed, parsePattern, normalizeHost };
