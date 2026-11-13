'use strict';

/**
 * Execution tools. These send real HTTP requests from this machine and run the collection's
 * pre-request / test scripts in the same sandbox as the Apilix app and CLI (unchanged).
 */

const core = require('@apilix/core');
const { findNode, buildRunTree, countRequests } = require('./model');
const { UNTRUSTED, REF, COLLECTION_ID, ENV_ID } = require('./tools');
const { WorkspaceError } = require('./workspace');
const exec = require('./exec');
const { runEnabled } = require('./args');

const RUN_WARNING = ' This tool SENDS REAL HTTP REQUESTS from the machine running the server (only to the hosts the operator allowed with --allow-host, or to ANY host when started with --allow-any-host) and EXECUTES the collection\'s pre-request/test scripts; requests can have side effects. Variables/data you provide cannot change the host a request is sent to.';
const RUN_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** Why the run tools are unavailable, and how the operator can enable them. */
const disabledMessage = (o) => (o.noRun
  ? 'Running requests is disabled on this server (started with --no-run).'
  : 'Running requests is not enabled on this server. The operator must restart it with --allow-host <pattern> (recommended: only those hosts are reachable) or --allow-any-host (no host restriction).');

const VARIABLES = {
  type: 'object',
  maxProperties: 100,
  propertyNames: { maxLength: 200 },
  additionalProperties: { type: ['string', 'number', 'boolean'], maxLength: 10000 },
  description: 'Optional variable overrides ({{name}} values). Precedence: data > environment > variables > collection variables.',
};
const TIMEOUT = { type: 'integer', minimum: 1000, maximum: 900000, description: 'Wall-clock limit for this call in ms (default: the server --run-timeout).' };

async function loadEnv(ctx, id) {
  if (!id) return {};
  const e = await ctx.loadEnvironment(id);
  return exec.valuesToMap(e.value.values);
}

function commonJob(ctx, args, extra) {
  return {
    timeoutMs: args.timeoutMs || ctx.opts.runTimeoutSec * 1000,
    delayMs: args.delayMs || 0,
    bail: args.bail === true,
    signal: extra && extra.signal,
    ...extra,
  };
}

function summarize(results) {
  const iterations = exec.toIterations(results);
  const s = core.summarizeRun(iterations);
  return { iterations, summary: { requests: s.requests, testsPassed: s.passed, testsFailed: s.failed, requestErrors: s.errors, testsSkipped: s.skipped } };
}

function budget(ctx) {
  return {
    requestsUsed: ctx.session.requestsUsed,
    requestsRemaining: Math.max(0, ctx.opts.maxRequests - ctx.session.requestsUsed),
    runSecondsRemaining: Math.max(0, Math.round(ctx.opts.maxRunSeconds - ctx.session.msUsed / 1000)),
  };
}

const tools = [
  {
    name: 'run_request',
    title: 'Run one request',
    description: 'Run a single request of a collection (with its collection/folder scripts) and return the redacted response: status, timing, headers, body (truncated), test results and errors.' + RUN_WARNING + UNTRUSTED,
    enabled: runEnabled,
    disabledMessage,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['collection', 'request'],
      properties: {
        collection: COLLECTION_ID,
        request: { ...REF, description: 'Request ref (from list_requests), item id, or "Folder/Name" path.' },
        environment: ENV_ID,
        variables: VARIABLES,
        data: { ...VARIABLES, description: 'Optional data row ({{name}} values with the highest precedence).' },
        includeResponseBody: { type: 'boolean', description: 'Return headers and body (default true).' },
        maxBodyBytes: { type: 'integer', minimum: 0, maximum: 65536, description: 'Maximum characters of response body returned (default 4096).' },
        timeoutMs: TIMEOUT,
      },
    },
    annotations: RUN_ANNOTATIONS,
    async handler(args, ctx, extra) {
      const c = await ctx.loadCollection(args.collection);
      const entry = findNode(c.value, args.request, { type: 'request' });
      const { collection, skippedNonHttp } = buildRunTree(c.value, entry.pos);
      if (skippedNonHttp.length) throw new exec.ExpectedError('Only HTTP requests can be run through MCP (database/MongoDB requests are not supported).');
      const environment = await loadEnv(ctx, args.environment);
      const started = new Date().toISOString();
      const run = await exec.runTree(ctx, {
        ...commonJob(ctx, args, extra),
        collection,
        requestCount: countRequests(collection.item),
        iterations: 1,
        environment,
        variables: exec.stringMap(args.variables),
        dataRows: args.data ? [exec.stringMap(args.data)] : null,
      });
      const opts = { includeBody: args.includeResponseBody !== false, maxBodyBytes: args.maxBodyBytes === undefined ? 4096 : args.maxBodyBytes };
      const shaped = run.results.map((r) => exec.shapeResult(r, ctx.redactor, opts));
      const { summary } = summarize(run.results);
      const out = {
        untrustedContent: true,
        runId: run.runId,
        collection: c.id,
        request: ctx.redactor.text(entry.path, 600),
        result: shaped[0] || null,
        summary,
        timedOut: run.timedOut || undefined,
        cancelled: run.cancelled || undefined,
        budgetExceeded: run.budgetExceeded || undefined,
        errors: run.errors.map((e) => ctx.redactor.text(e, 300)),
        budget: budget(ctx),
      };
      exec.recordHistory(ctx.session, {
        runId: run.runId, tool: 'run_request', collection: c.id, startedAt: started, durationMs: run.durationMs, summary,
        failures: shaped.filter((_, i) => exec.isFailure(run.results[i])).slice(0, 5).map((s) => ({ name: s.name, status: s.status, error: s.error, failedTests: s.tests.filter((t) => t.passed === false) })),
      });
      return JSON.parse(JSON.stringify(out));
    },
  },
  {
    name: 'run_collection',
    title: 'Run a collection or folder',
    description: 'Run a whole collection (or one folder) like `apilix run`: returns a summary, the failing requests/tests, and per-request results (bounded). Optional environment, variable overrides, iterations or data rows, delay between requests, and bail-on-first-failure. Response bodies are omitted unless requested.' + RUN_WARNING + UNTRUSTED,
    enabled: runEnabled,
    disabledMessage,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['collection'],
      properties: {
        collection: COLLECTION_ID,
        folder: { ...REF, description: 'Optional folder ref/path: run only this folder.' },
        environment: ENV_ID,
        variables: VARIABLES,
        iterations: { type: 'integer', minimum: 1, maximum: 20, description: 'Iteration count (default 1). Not combinable with data.' },
        data: { type: 'array', maxItems: 50, items: { ...VARIABLES, description: 'One data row.' }, description: 'Optional data rows; one iteration per row.' },
        delayMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'Delay between requests.' },
        bail: { type: 'boolean', description: 'Stop at the first failed test or request error.' },
        reporter: { type: 'string', enum: ['json', 'junit'], description: 'json (default): structured results. junit: JUnit XML in "report" (bounded).' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum per-request results listed (default 50). Failures are always listed separately.' },
        includeResponseBody: { type: 'boolean', description: 'Include headers/body in per-request results (default false).' },
        maxBodyBytes: { type: 'integer', minimum: 0, maximum: 16384, description: 'Maximum characters of body per result when included (default 1024).' },
        timeoutMs: TIMEOUT,
      },
    },
    annotations: RUN_ANNOTATIONS,
    async handler(args, ctx, extra) {
      if (args.data && args.iterations) throw new exec.ExpectedError('Use either data or iterations, not both');
      const c = await ctx.loadCollection(args.collection);
      let pos = null;
      if (args.folder) pos = findNode(c.value, args.folder, { type: 'folder' }).pos;
      const { collection, skippedNonHttp } = buildRunTree(c.value, pos);
      const environment = await loadEnv(ctx, args.environment);
      const dataRows = args.data ? args.data.map((r) => exec.stringMap(r)) : null;
      const iterations = dataRows ? dataRows.length : (args.iterations || 1);
      if (dataRows && dataRows.length === 0) throw new exec.ExpectedError('data must contain at least one row');
      const started = new Date().toISOString();
      const run = await exec.runTree(ctx, {
        ...commonJob(ctx, args, extra),
        collection,
        requestCount: countRequests(collection.item),
        iterations,
        environment,
        variables: exec.stringMap(args.variables),
        dataRows,
      });
      const opts = { includeBody: args.includeResponseBody === true, maxBodyBytes: args.maxBodyBytes === undefined ? 1024 : args.maxBodyBytes };
      const shaped = run.results.map((r) => exec.shapeResult(r, ctx.redactor, opts));
      const { iterations: iters, summary } = summarize(run.results);
      const failures = shaped.filter((_, i) => exec.isFailure(run.results[i])).slice(0, 50).map((s) => ({
        iteration: s.iteration, name: s.name, method: s.method, status: s.status, error: s.error, failedTests: s.tests.filter((t) => t.passed === false),
      }));
      const maxResults = args.maxResults || 50;
      const out = {
        untrustedContent: true,
        runId: run.runId,
        collection: c.id,
        folder: args.folder ? ctx.redactor.text(args.folder, 300) : undefined,
        summary,
        ok: summary.testsFailed === 0 && summary.requestErrors === 0 && run.errors.length === 0 && !run.timedOut,
        durationMs: run.durationMs,
        stopped: run.stopped || undefined,
        timedOut: run.timedOut || undefined,
        cancelled: run.cancelled || undefined,
        budgetExceeded: run.budgetExceeded || undefined,
        skippedNonHttpRequests: skippedNonHttp.length ? skippedNonHttp.slice(0, 20).map((n) => ctx.redactor.text(n, 200)) : undefined,
        errors: run.errors.slice(0, 20).map((e) => ctx.redactor.text(e, 300)),
        failures,
        budget: budget(ctx),
      };
      if (args.reporter === 'junit') {
        const xml = core.buildJUnitReport({
          collectionName: ctx.redactor.text(String(c.value.info.name || ''), 200),
          iterations: toRedactedIterations(iters, ctx.redactor),
          errors: out.errors,
        });
        const limit = Math.max(2000, ctx.limits.maxOutputChars - 8000);
        const scrubbed = ctx.redactor.scrub(xml);
        out.report = scrubbed.length > limit ? scrubbed.slice(0, limit) : scrubbed;
        out.reportTruncated = scrubbed.length > limit;
      } else {
        out.results = shaped.slice(0, maxResults);
        out.omittedResults = Math.max(0, shaped.length - maxResults);
      }
      exec.recordHistory(ctx.session, { runId: run.runId, tool: 'run_collection', collection: c.id, startedAt: started, durationMs: run.durationMs, summary, failures: failures.slice(0, 20) });
      return shrinkToFit(JSON.parse(JSON.stringify(out)), ctx.limits.maxOutputChars);
    },
  },
  {
    name: 'get_last_results',
    title: 'Results of the latest runs in this session',
    description: 'Return the summaries and failures of the most recent run_request/run_collection calls made in this server session (newest first, at most 10 kept in memory). Does not execute anything.' + UNTRUSTED,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of runs to return (default 3).' },
        runId: { type: 'string', minLength: 1, maxLength: 100, description: 'Return only this run.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args, ctx) {
      let runs = ctx.session.history;
      if (args.runId) runs = runs.filter((r) => r.runId === args.runId);
      return { untrustedContent: true, runs: runs.slice(0, args.limit || 3), kept: ctx.session.history.length, budget: budget(ctx) };
    },
  },
];

/** JUnit builds on result objects; give it already-redacted fields. */
function toRedactedIterations(iterations, redactor) {
  return iterations.map((it) => ({
    iteration: it.iteration,
    results: it.results.map((r) => ({
      ...r,
      name: redactor.text(String(r.name || ''), 200),
      error: r.error ? redactor.text(String(r.error), 500) : r.error,
      body: '',
      testResults: (r.testResults || []).map((t) => ({ ...t, name: redactor.text(String(t.name), 300), error: t.error ? redactor.text(String(t.error), 500) : t.error })),
      preChildRequests: [],
      testChildRequests: [],
    })),
  }));
}

/** Drop trailing per-request results until the JSON fits, flagging the omission. */
function shrinkToFit(out, maxChars) {
  if (!out.results) return out;
  while (JSON.stringify(out).length > maxChars && out.results.length > 1) {
    const keep = Math.max(1, Math.floor(out.results.length / 2));
    out.omittedResults = (out.omittedResults || 0) + (out.results.length - keep);
    out.results = out.results.slice(0, keep);
    out.resultsTruncated = true;
  }
  return out;
}

module.exports = { tools, shrinkToFit, WorkspaceError };
