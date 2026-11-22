'use strict';

/**
 * Worker-thread side of schema-guard: runs schema validation so the parent can abandon (terminate) it
 * when a user-supplied `pattern` backtracks catastrophically. The parent blocks on Atomics.wait and reads
 * the reply with receiveMessageOnPort, so every reply is: post to the port, then store + notify the flag.
 */

const { parentPort, workerData } = require('node:worker_threads');
const { validateAgainstSchema } = require('./schema-validator');

const { sab, port } = workerData;
const flag = new Int32Array(sab);
const registries = new Map(); // fingerprint -> schemas (small LRU, mirrors the parent's cache size)
const MAX_REGISTRIES = 20;

function reply(msg) {
  port.postMessage(msg);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

parentPort.on('message', (m) => {
  if (m.type === 'ping') return reply({ type: 'ready' });
  try {
    let schemas = m.schemas;
    if (schemas) {
      registries.delete(m.fp);
      registries.set(m.fp, schemas);
      if (registries.size > MAX_REGISTRIES) registries.delete(registries.keys().next().value);
    } else {
      schemas = registries.get(m.fp);
      if (!schemas) return reply({ type: 'need-schemas' });
    }
    const result = validateAgainstSchema(m.schema, m.data, { schemas, allErrors: m.allErrors });
    reply({ type: 'result', result });
  } catch (e) {
    reply({ type: 'throw', message: String((e && e.message) || e).slice(0, 500) });
  }
});
