'use strict';

/**
 * Execution layer shared by run_request and run_collection: builds the runner payload from
 * workspace files, enforces budgets/timeouts, and turns raw runner results into bounded, redacted data.
 * Requests run through @apilix/core exactly as in the CLI (same engine, same script sandbox).
 */

const core = require('@apilix/core');
const { findHostOverride } = require('./model');
const { trackSockets } = require('./host-guard');

const MAX_REQUESTS_PER_CALL = 200;
const HARD_TIMEOUT_GRACE_MS = 2000;
const HARD_ABORT_GRACE_MS = 2000;
const MAX_RUN_HISTORY = 10;

class ExpectedError extends Error {
  constructor(message) { super(message); this.expected = true; }
}

function createSession() {
  let tail = Promise.resolve();
  return {
    requestsUsed: 0,
    msUsed: 0,
    /** true once a run could not be stopped and was abandoned (it may still finish in the background) */
    degraded: false,
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
  // A request cancelled (notifications/cancelled) before it started, e.g. while queued behind another run,
  // must not reach the network.
  // job.signal: notifications/cancelled for this call; job.shutdown: the client closed stdin / the server is stopping.
  const signals = [job.signal, job.shutdown].filter(Boolean);
  const cancelledBeforeStart = () => { if (signals.some((sg) => sg.aborted)) throw new ExpectedError('Cancelled before it started'); };
  cancelledBeforeStart();
  const requestsInTree = job.requestCount * job.iterations;
  if (requestsInTree === 0) throw new ExpectedError('Nothing to run: the selection contains no HTTP requests');
  if (requestsInTree > MAX_REQUESTS_PER_CALL) {
    throw new ExpectedError(`This call would execute ${requestsInTree} requests; the per-call limit is ${MAX_REQUESTS_PER_CALL}. Select a folder or reduce iterations.`);
  }
  const moved = findHostOverride(job.collection, { environment: job.environment, variables: job.variables, dataRows: job.dataRows || [null], anyHost: opts.allowAnyHost === true });
  if (moved) {
    const what = moved.field === 'url' ? `the target host of "${moved.request}"` : `the ${moved.field} host of "${moved.request}"`;
    throw new ExpectedError(moved.noBaseline
      ? `Refused: the variables/data you supplied would define ${what} ("${moved.to}"), which the collection and the environment leave undefined. With --allow-any-host nothing but your own values would vouch for that host. Define the host in the environment or the collection (the operator can also use --allow-host).`
      : `Refused: the variables/data you supplied would change ${what} from "${moved.from}" to "${moved.to}". Variables and data may not redirect a request to another host (the environment and the collection decide where requests go).`);
  }

  return session.lock(async () => {
    cancelledBeforeStart(); // it may have been cancelled while waiting for the lock
    // Budgets are checked HERE, under the lock: calls queued behind another run must see what that run consumed.
    if (session.requestsUsed + requestsInTree > opts.maxRequests) {
      throw new ExpectedError(`Session request budget exhausted (${session.requestsUsed}/${opts.maxRequests} used, ${requestsInTree} needed). Restart the server to reset it.`);
    }
    if (session.msUsed >= opts.maxRunSeconds * 1000) {
      throw new ExpectedError(`Session run-time budget exhausted (${opts.maxRunSeconds}s). Restart the server to reset it.`);
    }
    const timeoutMs = Math.min(job.timeoutMs, Math.max(1000, opts.maxRunSeconds * 1000 - session.msUsed));
    const tracker = trackSockets();
    const state = { timedOut: false, budgetExceeded: false, cancelled: false };
    const runState = { paused: false, stopped: false };
    const results = [];
    const runErrors = [];
    const started = Date.now();
    let abandoned = false;
    let outcome;
    let prepared;
    let onAbort;
    try {
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
      prepared = core.prepareCollectionRun(payload, { jsonRows: job.dataRows || undefined });

      const onEvent = (event, data) => {
        if (event === 'result') {
          session.requestsUsed += 1 + (data.preChildRequests || []).length + (data.testChildRequests || []).length;
          if (!abandoned) results.push(data);
          if (session.requestsUsed >= opts.maxRequests) { state.budgetExceeded = true; runState.stopped = true; }
        } else if (event === 'error' && !abandoned) {
          runErrors.push(String(data && data.error));
        }
      };
      onAbort = () => { state.cancelled = true; runState.stopped = true; tracker.destroyAll(); };
      for (const sg of signals) sg.addEventListener('abort', onAbort);

      const softTimer = setTimeout(() => { state.timedOut = true; runState.stopped = true; }, timeoutMs);
      let hardTimer;
      const hard = new Promise((resolve) => { hardTimer = setTimeout(() => resolve('hard'), timeoutMs + HARD_TIMEOUT_GRACE_MS); });
      const real = core.executePreparedCollectionRun(prepared, { runState, onEvent, collectIterations: false });
      const settled = Promise.resolve(real).then((r) => ({ run: r }), (e) => ({ failure: e }));
      try {
        outcome = await Promise.race([settled, hard]);
      } finally {
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
      }
      if (outcome === 'hard') {
        // The run ignored the soft stop (a request or script is stuck). Tear its sockets down, give it a short
        // grace period, then give up on it: the lock is released either way, the session is flagged as degraded.
        state.timedOut = true;
        runState.stopped = true;
        tracker.destroyAll();
        let graceTimer;
        const grace = new Promise((resolve) => { graceTimer = setTimeout(() => resolve('late'), HARD_ABORT_GRACE_MS); });
        try {
          outcome = await Promise.race([settled, grace]);
        } finally {
          clearTimeout(graceTimer);
        }
        if (outcome === 'late') {
          abandoned = true;
          session.degraded = true;
          runErrors.push(`The run did not stop after ${Math.round((timeoutMs + HARD_TIMEOUT_GRACE_MS + HARD_ABORT_GRACE_MS) / 1000)}s and was abandoned; its results are partial.`);
          if (typeof ctx.log === 'function') ctx.log('a run could not be stopped and was abandoned: the session is flagged as degraded');
          outcome = undefined;
        }
      }
    } finally {
      if (onAbort) for (const sg of signals) sg.removeEventListener('abort', onAbort);
      tracker.stop();
      session.msUsed += Date.now() - started;
    }
    if (outcome && outcome.failure) throw outcome.failure;
    return {
      results: results.slice(),
      errors: runErrors.slice(),
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
