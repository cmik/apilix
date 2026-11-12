'use strict';

/**
 * Execution layer shared by run_request and run_collection: builds the runner payload from
 * workspace files, enforces budgets/timeouts, and turns raw runner results into bounded, redacted data.
 * Requests run through @apilix/core exactly as in the CLI (same engine, same script sandbox).
 */

const core = require('@apilix/core');

const MAX_REQUESTS_PER_CALL = 200;
const HARD_TIMEOUT_GRACE_MS = 2000;
const MAX_RUN_HISTORY = 10;

class ExpectedError extends Error {
  constructor(message) { super(message); this.expected = true; }
}

function createSession() {
  let tail = Promise.resolve();
  return {
    requestsUsed: 0,
    msUsed: 0,
    history: [],
    /** Serialize runs: the engine config is process-global. Released only when the run really settled. */
    lock(fn) {
      const run = tail.then(fn, fn);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

function valuesToMap(values) {
  const out = {};
  for (const e of Array.isArray(values) ? values : []) {
    if (!e || typeof e.key !== 'string' || !e.key) continue;
    if (e.enabled === false || e.disabled === true) continue;
    out[e.key] = e.value == null ? '' : String(e.value);
  }
  return out;
}

function stringMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = v == null ? '' : String(v);
  return out;
}

function shapeResult(r, redactor, { includeBody, maxBodyBytes }) {
  const tests = (r.testResults || []).slice(0, 100).map((t) => ({
    name: redactor.text(String(t.name), 300),
    passed: t.skipped ? null : t.passed,
    ...(t.error ? { error: redactor.text(String(t.error), 500) } : {}),
  }));
  const out = {
    iteration: r.iteration,
    name: redactor.text(String(r.name || ''), 200),
    method: String(r.method || ''),
    url: redactor.url(String(r.url || '')),
    resolvedUrl: redactor.url(String(r.resolvedUrl || '')),
    status: r.status,
    statusText: redactor.text(String(r.statusText || ''), 100),
    responseTimeMs: r.responseTime,
    size: r.size,
    skipped: r.skipped === true || undefined,
    error: r.error ? redactor.text(String(r.error), 500) : undefined,
    tests,
    warnings: (r.warnings || []).slice(0, 10).map((w) => redactor.text(String(w), 300)),
    retryAttempts: r.retryAttempts || undefined,
  };
  if (includeBody) {
    out.requestHeaders = redactor.headers(r.requestHeaders);
    out.headers = redactor.headers(r.headers);
    if (r.requestBody != null && r.requestBody !== '') {
      out.requestBody = redactor.clip(redactor.body(redactor.clip(typeof r.requestBody === 'string' ? r.requestBody : JSON.stringify(r.requestBody), 1048576)), 2048);
    }
    const raw = typeof r.body === 'string' ? r.body : (r.body == null ? '' : JSON.stringify(r.body));
    const redacted = redactor.body(raw.length > 1048576 ? raw.slice(0, 1048576) : raw);
    out.body = redacted.length > maxBodyBytes ? redacted.slice(0, maxBodyBytes) : redacted;
    out.bodyTruncated = raw.length > maxBodyBytes || redacted.length > maxBodyBytes;
    out.bodyChars = raw.length;
  }
  const logs = (r.scriptLogs || []).slice(0, 20).map((l) => ({ level: l.level, message: redactor.text((l.args || []).join(' '), 500) }));
  if (logs.length) out.scriptLogs = logs;
  const children = [...(r.preChildRequests || []), ...(r.testChildRequests || [])];
  if (children.length) {
    out.childRequests = children.slice(0, 10).map((c) => ({
      name: redactor.text(String(c.name || ''), 200), method: c.method, status: c.result && c.result.status,
      error: c.result && c.result.error ? redactor.text(String(c.result.error), 300) : undefined,
    }));
  }
  return JSON.parse(JSON.stringify(out)); // drop undefined
}

function isFailure(r) {
  return !!r.error || (r.testResults || []).some((t) => t && t.passed === false);
}

/**
 * Run a prepared tree. Returns raw results gathered from runner events (so a timeout still yields partial data).
 */
async function runTree(ctx, job) {
  const { opts, session } = ctx;
  const requestsInTree = job.requestCount * job.iterations;
  if (requestsInTree === 0) throw new ExpectedError('Nothing to run: the selection contains no HTTP requests');
  if (requestsInTree > MAX_REQUESTS_PER_CALL) {
    throw new ExpectedError(`This call would execute ${requestsInTree} requests; the per-call limit is ${MAX_REQUESTS_PER_CALL}. Select a folder or reduce iterations.`);
  }
  if (session.requestsUsed + requestsInTree > opts.maxRequests) {
    throw new ExpectedError(`Session request budget exhausted (${session.requestsUsed}/${opts.maxRequests} used, ${requestsInTree} needed). Restart the server to reset it.`);
  }
  if (session.msUsed >= opts.maxRunSeconds * 1000) {
    throw new ExpectedError(`Session run-time budget exhausted (${opts.maxRunSeconds}s). Restart the server to reset it.`);
  }
  const timeoutMs = Math.min(job.timeoutMs, Math.max(1000, opts.maxRunSeconds * 1000 - session.msUsed));

  return session.lock(async () => {
    core.setExecutorConfig({
      followRedirects: true,
      requestTimeout: Math.min(opts.requestTimeoutMs, timeoutMs),
      sslVerification: opts.sslVerification === true,
      proxyEnabled: false,
      httpProxy: '',
      httpsProxy: '',
      noProxy: '',
      customCAs: '',
      clientCertificates: [],
    });
    const payload = {
      collection: job.collection,
      environment: job.environment,
      collectionVariables: job.variables,
      globals: {},
      cookies: {},
      delay: job.delayMs,
      iterations: job.iterations,
      executeChildRequests: false,
      conditionalExecution: true,
      bail: job.bail === true,
      maxRetries: 0,
      allCollectionItems: job.collection.item,
      mockBase: null,
      mongoConnections: {},
      databases: [],
      dbQueryFn: null,
      dbMongoQueryFn: null,
    };
    const prepared = core.prepareCollectionRun(payload, { jsonRows: job.dataRows || undefined });
    const runState = { paused: false, stopped: false };
    const results = [];
    const runErrors = [];
    const state = { timedOut: false, budgetExceeded: false, cancelled: false };
    const started = Date.now();

    const onEvent = (event, data) => {
      if (event === 'result') {
        results.push(data);
        session.requestsUsed += 1 + (data.preChildRequests || []).length + (data.testChildRequests || []).length;
        if (session.requestsUsed >= opts.maxRequests) { state.budgetExceeded = true; runState.stopped = true; }
      } else if (event === 'error') {
        runErrors.push(String(data && data.error));
      }
    };
    if (job.signal) job.signal.addEventListener('abort', () => { state.cancelled = true; runState.stopped = true; });

    const softTimer = setTimeout(() => { state.timedOut = true; runState.stopped = true; }, timeoutMs);
    let hardTimer;
    const hard = new Promise((resolve) => { hardTimer = setTimeout(() => resolve('hard'), timeoutMs + HARD_TIMEOUT_GRACE_MS); });
    const real = core.executePreparedCollectionRun(prepared, { runState, onEvent, collectIterations: false });
    const settled = real.then((r) => ({ run: r }), (e) => ({ failure: e }));
    let outcome;
    try {
      outcome = await Promise.race([settled, hard]);
    } finally {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    }
    if (outcome === 'hard') {
      state.timedOut = true;
      // Keep the lock until the real run settles so two runs never overlap.
      await settled;
    }
    if (outcome && outcome.failure) throw outcome.failure;
    session.msUsed += Date.now() - started;
    return {
      results,
      errors: runErrors,
      runId: prepared.runId,
      stopped: runState.stopped === true,
      durationMs: Date.now() - started,
      ...state,
    };
  });
}

/** Group raw results by iteration for summarizeRun/buildJUnitReport. */
function toIterations(results) {
  const byIter = new Map();
  for (const r of results) {
    if (!byIter.has(r.iteration)) byIter.set(r.iteration, { iteration: r.iteration, results: [] });
    byIter.get(r.iteration).results.push(r);
  }
  return [...byIter.values()];
}

function recordHistory(session, entry) {
  session.history.unshift(entry);
  if (session.history.length > MAX_RUN_HISTORY) session.history.length = MAX_RUN_HISTORY;
}

module.exports = {
  runTree, shapeResult, isFailure, toIterations, recordHistory, createSession, valuesToMap, stringMap,
  ExpectedError, MAX_REQUESTS_PER_CALL,
};
