'use strict';

const { PassThrough } = require('node:stream');

/** In-process harness: drives createRpcServer through PassThrough streams. */
function makeHarness(server) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = '';
  const waiters = [];
  output.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
    }
    for (const w of waiters.splice(0)) w();
  });
  const done = server.serve(input, output);
  async function next(timeoutMs = 10000) {
    const start = Date.now();
    while (lines.length === 0) {
      if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for a message');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 25); });
    }
    return JSON.parse(lines.shift());
  }
  return {
    send: (obj) => input.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`),
    sendRaw: (s) => input.write(s),
    next,
    pendingLines: () => lines.length,
    end: async () => { input.end(); await done; },
  };
}

module.exports = { makeHarness };
