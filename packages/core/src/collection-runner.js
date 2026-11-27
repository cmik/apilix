'use strict';

// csv-parse/sync uses package exports subpath — the direct CJS dist file is
// listed in pkg.assets so the snapshot resolver can find it when exports are
// not supported by the bundler.
let parseCsv;
try {
  parseCsv = require('csv-parse/sync').parse;
} catch (_) {
  parseCsv = require('csv-parse/dist/cjs/sync.cjs').parse;
}
const { executeRequest, flattenItemsWithScripts } = require('./request-engine');
const { createScriptContext } = require('./script-runtime');
const { validateWithTimeout } = require('./schema-guard');

const SCHEMA_MODES = ['off', 'warn', 'strict'];

/** Normalise a requested schema mode: unknown/absent -> 'warn'. */
function normalizeSchemaMode(mode) {
  return SCHEMA_MODES.includes(mode) ? mode : 'warn';
}

/** Effective mode of one link under the run-level ceiling. */
function effectiveSchemaMode(runMode, linkMode) {
  if (runMode === 'off' || linkMode === 'off') return 'off';
  const own = SCHEMA_MODES.includes(linkMode) ? linkMode : runMode;
  return runMode === 'warn' && own === 'strict' ? 'warn' : own;
}

/**
 * Pick the link for a response status: exact code ('404'), then class ('4xx'), then 'default'.
 */
function resolveSchemaLink(links, status) {
  if (!Array.isArray(links) || links.length === 0 || !Number.isInteger(status)) return null;
  const exact = String(status);
  const klass = `${Math.floor(status / 100)}xx`;
  const norm = l => String(l && l.match || '').toLowerCase();
  return links.find(l => norm(l) === exact)
    || links.find(l => norm(l) === klass)
    || links.find(l => norm(l) === 'default')
    || null;
}

/**
 * Build the synthetic `Schema: <status>` test for a response, or null when nothing is linked / mode is off.
 * Violation messages never contain response values (see schema-validator).
 *
 * `runMode` is a ceiling: 'off' disables everything, 'warn' downgrades strict links to warn, 'strict' lets each
 * link's own mode apply (a link mode of 'off' still disables that link; a link without a mode inherits the run mode).
 * `ctx` (optional, per run): `{ registry, timedOut: Map }` so the registry is built once and a schema that timed
 * out is not re-validated (and does not stall again) for every further request of the run.
 */
function buildSchemaTest(result, links, schemas, runMode, ctx) {
  if (runMode === 'off') return null;
  if (!result || result.error || !Number.isInteger(result.status)) return null;
  if (result.protocol && result.protocol !== 'http') return null;
  const link = resolveSchemaLink(links, result.status);
  if (!link) return null;
  const mode = effectiveSchemaMode(runMode, link.mode);
  if (mode === 'off') return null;

  const name = `Schema: ${result.status}`;
  const severity = mode === 'strict' ? 'fail' : 'warn';
  const violation = (message) => ({
    name, passed: severity === 'fail' ? false : true, error: message, synthetic: true, schemaSeverity: severity,
  });

  const entry = (Array.isArray(schemas) ? schemas : []).find(s => s && s.id === link.schemaId);
  if (!entry) return violation(`Linked schema "${String(link.schemaId).slice(0, 80)}" was not found`);

  const body = typeof result.body === 'string' ? result.body : '';
  if (body.trim() === '') {
    // Nothing to validate (204 / empty body): a skipped, passing synthetic test rather than a violation.
    return { name, passed: null, error: 'empty body, nothing to validate', synthetic: true, skipped: true };
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    return violation('Response body is not valid JSON');
  }

  const cacheKey = String(link.schemaId);
  const timedOutCache = ctx && ctx.timedOut instanceof Map ? ctx.timedOut : null;
  if (timedOutCache && timedOutCache.has(cacheKey)) return violation(timedOutCache.get(cacheKey));

  const registry = ctx && Array.isArray(ctx.registry)
    ? ctx.registry
    : schemas.filter(s => s && typeof s.name === 'string' && s.schema).map(s => ({ name: s.name, schema: s.schema }));
  const res = validateWithTimeout(entry.schema, data, { schemas: registry, allErrors: true });
  if (res.timedOut || res.unsafePattern) {
    const msg = `Schema "${entry.name}" could not be checked: ${res.errors[0].message}`;
    if (res.timedOut && timedOutCache) timedOutCache.set(cacheKey, `${msg} (skipped for the rest of this run)`);
    return violation(msg);
  }
  if (res.schemaError) return violation(`Schema "${entry.name}" is invalid: ${res.schemaError}`);
  if (res.valid) return { name, passed: true, error: null, synthetic: true };
  const shown = res.errors.slice(0, 5).map(e => `${e.path || '(root)'} ${e.message}`);
  const more = res.errors.length > 5 || res.truncated ? ` (+${res.truncated ? 'more than ' : ''}${res.errors.length - 5} more)` : '';
  return violation(`Does not match schema "${entry.name}": ${shown.join('; ')}${more}`);
}

const MAX_RUN_RUNTIME_MS = 1800 * 1000;

/**
 * Represents a client input error that should map to HTTP 400.
 * Thrown by prepareCollectionRun for missing/invalid payload fields.
 */
class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

function generateRunId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForResume(runState) {
  while (true) {
    if (!runState || runState.stopped) return 'stopped';
    if (!runState.paused) return 'running';
    await sleep(100);
  }
}

async function awaitDelay(runState, delayMs) {
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    const check = await waitForResume(runState);
    if (check === 'stopped') return 'stopped';
    await sleep(Math.min(50, Math.max(0, end - Date.now())));
  }
  return 'running';
}

function parseRunDataRows(payload, { csvText, jsonRows } = {}) {
  if (jsonRows !== undefined && jsonRows !== null) {
    if (!Array.isArray(jsonRows) || jsonRows.length === 0)
      throw new InputError('JSON data file must be a non-empty array of objects');
    return jsonRows;
  }
  if (csvText !== null && csvText !== undefined) {
    try {
      return parseCsv(csvText, { columns: true, skip_empty_lines: true, trim: true });
    } catch (csvErr) {
      throw new InputError(`Invalid CSV: ${csvErr.message}`);
    }
  }

  const iterCount = Math.max(1, Math.min(100, parseInt(payload?.iterations, 10) || 1));
  return iterCount > 1 ? Array.from({ length: iterCount }, () => ({})) : [{}];
}

function collectOrderedRequestIds(items) {
  const ids = [];
  function walk(nodes) {
    for (const item of (nodes || [])) {
      if (item.item) {
        walk(item.item);
      } else if (item.request && item.id) {
        ids.push(item.id);
      }
    }
  }
  walk(items);
  return ids;
}

function prepareCollectionRun(payload, options = {}) {
  if (!payload?.collection || !payload.collection.item) {
    throw new InputError('Missing collection in body');
  }

  const dataRows = parseRunDataRows(payload, { csvText: options.csvText, jsonRows: options.jsonRows });
  const baseItems = Array.isArray(payload.allCollectionItems) && payload.allCollectionItems.length > 0
    ? payload.allCollectionItems
    : payload.collection.item;

  const mergedRequests = flattenItemsWithScripts(baseItems, payload.collection.event);
  const orderedIds = collectOrderedRequestIds(payload.collection.item);

  let requests = mergedRequests;
  if (orderedIds.length > 0) {
    const byId = new Map(mergedRequests.map(req => [req.id, req]));
    // Build the ordered list of ID-bearing requests the caller selected.
    const orderedById = orderedIds
      .map(id => byId.get(id))
      .filter(req => req !== undefined);
    // Preserve any ID-less requests (uncommon, but valid in hand-crafted
    // Postman collections) by appending them after the ordered set.
    const noIdRequests = mergedRequests.filter(req => !req.id);
    requests = [...orderedById, ...noIdRequests];
  }

  return {
    payload,
    dataRows,
    requests,
    runId: options.runId || generateRunId(),
  };
}

function toResultData(item, result, iteration) {
  const isMongo = result.protocol === 'mongodb' || item.request?.requestType === 'mongodb' || !!item.request?.mongodb;
  const isSql = result.protocol === 'sql' || item.request?.requestType === 'sql' || !!item.request?.sql || item.request?.method === 'MYSQL' || item.request?.method === 'POSTGRESQL';
  const mongoOperation = item.request?.mongodb?.operation || result.mongoOperation;
  const sqlDialect = result.sqlDialect || item.request?.sql?.dialect || (item.request?.method === 'POSTGRESQL' ? 'postgres' : item.request?.method === 'MYSQL' ? 'mysql' : undefined);
  const methodLabel = isMongo
    ? `MONGO:${String(mongoOperation || 'op').toUpperCase()}`
    : isSql
      ? `SQL:${String(sqlDialect || 'dialect').toUpperCase()}`
      : (item.request?.method || 'GET');
  return {
    iteration,
    name: item.name,
    method: methodLabel,
    protocol: isMongo ? 'mongodb' : isSql ? 'sql' : 'http',
    mongoOperation,
    mongoStatus: result.mongoStatus,
    sqlDialect,
    sqlConnectionId: result.sqlConnectionId || item.request?.sql?.connectionId,
    url: typeof item.request?.url === 'string'
      ? item.request.url
      : item.request?.url?.raw || '',
    resolvedUrl: result.resolvedUrl,
    requestHeaders: result.requestHeaders,
    requestBody: result.requestBody,
    status: result.status,
    statusText: result.statusText,
    responseTime: result.responseTime,
    headers: result.headers,
    body: result.body,
    size: result.size,
    testResults: result.testResults,
    scriptLogs: result.scriptLogs,
    preChildRequests: result.preChildRequests || [],
    testChildRequests: result.testChildRequests || [],
    skipped: result.skipped || false,
    warnings: result.warnings || [],
    error: result.error,
    retryAttempts: result._retryAttempts || 0,
  };
}

async function executePreparedCollectionRun(prepared, options = {}) {
  const { payload, dataRows, requests, runId } = prepared;
  const runStart = Date.now();
  const {
    collection,
    environment,
    collectionVariables,
    globals,
    delay,
    cookies,
    executeChildRequests,
    conditionalExecution,
    bail,
    allCollectionItems,
    mockBase,
    mongoConnections,
    databases,
    dbQueryFn,
    dbMongoQueryFn,
    dbRedisCommandFn,
    dbDynamoOperationFn,
  } = payload;
  const schemaMode = normalizeSchemaMode(payload.schemaMode);
  const schemas = Array.isArray(payload.schemas)
    ? payload.schemas
    : (Array.isArray(collection?.apilix?.schemas) ? collection.apilix.schemas : []);
  const linksByRequestId = (payload.links && typeof payload.links === 'object' && !Array.isArray(payload.links)) ? payload.links : {};
  const schemaRegistry = schemas.filter(s => s && typeof s.name === 'string' && s.schema).map(s => ({ name: s.name, schema: s.schema }));
  const schemaCtx = { registry: schemaRegistry, timedOut: new Map() };
  const maxRetries = Math.max(0, Math.min(10, parseInt(payload.maxRetries, 10) || 0));
  const _rawRetryDelay = parseInt(payload.retryDelay, 10);
  const retryDelay = Math.max(0, Math.min(30000, Number.isNaN(_rawRetryDelay) ? 1000 : _rawRetryDelay));
  const retryBackoff = payload.retryBackoff === 'exponential' ? 'exponential' : 'fixed';
  const retryOn = ['failures', 'errors', 'both'].includes(payload.retryOn) ? payload.retryOn : 'both';
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const runState = options.runState || { paused: false, stopped: false };
  const collectIterations = options.collectIterations !== false;
  const collectResults = options.collectResults !== false;
  const sendEvent = (event, data) => {
    if (onEvent) onEvent(event, data);
  };

  sendEvent('run-id', { runId });

  const iterations = [];
  const errors = [];
  const delayMs = Math.min(parseInt(delay, 10) || 0, 5000);
  const requestIdToIndex = new Map(requests.map((request, index) => [request.id, index]));

  let stopped = false;
  outer: for (let i = 0; i < dataRows.length; i++) {
    if (Date.now() - runStart > MAX_RUN_RUNTIME_MS) {
      errors.push(`Run timed out after ${MAX_RUN_RUNTIME_MS}ms`);
      sendEvent('error', { error: `Run timed out after ${MAX_RUN_RUNTIME_MS}ms` });
      stopped = true;
      break;
    }
    const dataRow = dataRows[i];
    let currentEnv = { ...(environment || {}) };
    let currentCollVars = { ...(collectionVariables || {}) };
    let currentGlobals = { ...(globals || {}) };
    let currentCookies = { ...(cookies || {}) };
    const vmContext = createScriptContext();
    const iterationRecord = collectIterations
      ? { iteration: i + 1, dataRow, results: [] }
      : null;
    if (iterationRecord) iterations.push(iterationRecord);

    sendEvent('iteration-start', { iteration: i + 1, dataRow });

    let reqIdx = 0;
    const perRequestCount = new Array(requests.length).fill(0);
    const maxPerRequest = requests.length + 1;

    while (reqIdx < requests.length) {
      if (Date.now() - runStart > MAX_RUN_RUNTIME_MS) {
        errors.push(`Run timed out after ${MAX_RUN_RUNTIME_MS}ms`);
        sendEvent('error', { error: `Run timed out after ${MAX_RUN_RUNTIME_MS}ms` });
        stopped = true;
        break outer;
      }
      perRequestCount[reqIdx]++;
      if (perRequestCount[reqIdx] > maxPerRequest) {
        const loopName = requests[reqIdx].name;
        const error = `Iteration ${i + 1} aborted: "${loopName}" was reached ${perRequestCount[reqIdx]} times — circular conditional execution detected (setNextRequest() or setNextRequestById()).`;
        errors.push(error);
        sendEvent('error', { error });
        break;
      }

      const item = requests[reqIdx];
      if ((await waitForResume(runState)) === 'stopped') {
        stopped = true;
        break outer;
      }

      let result = await executeRequest(item, {
        environment: currentEnv,
        collectionVariables: currentCollVars,
        globals: currentGlobals,
        dataRow,
        collVars: collection.variable || [],
        cookies: currentCookies,
        collectionItems: executeChildRequests ? (allCollectionItems || collection.item || []) : [],
        conditionalExecution: conditionalExecution !== false,
        mockBase: mockBase || null,
        iteration: i + 1,
        requestId: item.id || '',
        vmContext,
        mongoConnections: mongoConnections || {},
        databases: databases || [],
        dbQueryFn: dbQueryFn || null,
        dbMongoQueryFn: dbMongoQueryFn || null,
        dbRedisCommandFn: dbRedisCommandFn || null,
        dbDynamoOperationFn: dbDynamoOperationFn || null,
        schemaRegistry,
      });

      if (result.updatedEnvironment) currentEnv = result.updatedEnvironment;
      if (result.updatedCollectionVariables) currentCollVars = result.updatedCollectionVariables;
      if (result.updatedGlobals) currentGlobals = result.updatedGlobals;
      if (result.updatedCookies) currentCookies = result.updatedCookies;

      let retryAttempts = 0;
      if (maxRetries > 0 && result.protocol !== 'mongodb') {
        while (retryAttempts < maxRetries) {
          const hasError = !!result.error;
          const hasFailed = Array.isArray(result.testResults)
            && result.testResults.some(t => t && t.passed === false);
          const shouldRetry =
            retryOn === 'errors'   ? hasError :
            retryOn === 'failures' ? hasFailed :
            /* both */               (hasError || hasFailed);
          if (!shouldRetry) break;
          retryAttempts++;
          const backoffMs = retryBackoff === 'exponential'
            ? Math.min(30000, retryDelay * Math.pow(2, retryAttempts - 1))
            : retryDelay;
          if (backoffMs > 0 && (await awaitDelay(runState, backoffMs)) === 'stopped') {
            stopped = true;
            break outer;
          }
          result = await executeRequest(item, {
            environment: currentEnv,
            collectionVariables: currentCollVars,
            globals: currentGlobals,
            dataRow,
            collVars: collection.variable || [],
            cookies: currentCookies,
            collectionItems: executeChildRequests ? (allCollectionItems || collection.item || []) : [],
            conditionalExecution: conditionalExecution !== false,
            mockBase: mockBase || null,
            iteration: i + 1,
            requestId: item.id || '',
            vmContext,
            mongoConnections: mongoConnections || {},
            databases: databases || [],
            dbQueryFn: dbQueryFn || null,
            dbMongoQueryFn: dbMongoQueryFn || null,
            dbRedisCommandFn: dbRedisCommandFn || null,
            dbDynamoOperationFn: dbDynamoOperationFn || null,
            schemaRegistry,
          });
          if (result.updatedEnvironment) currentEnv = result.updatedEnvironment;
          if (result.updatedCollectionVariables) currentCollVars = result.updatedCollectionVariables;
          if (result.updatedGlobals) currentGlobals = result.updatedGlobals;
          if (result.updatedCookies) currentCookies = result.updatedCookies;
        }
      }
      result._retryAttempts = retryAttempts;

      if (schemaMode !== 'off') {
        const links = (item.id && Array.isArray(linksByRequestId[item.id]))
          ? linksByRequestId[item.id]
          : item.request?.apilix?.schemaLinks;
        const schemaTest = buildSchemaTest(result, links, schemas, schemaMode, schemaCtx);
        if (schemaTest) result.testResults = [...(result.testResults || []), schemaTest];
      }

      const resultData = toResultData(item, result, i + 1);
      if (collectResults && iterationRecord) iterationRecord.results.push(resultData);
      sendEvent('result', resultData);

      const hasFailedTests = Array.isArray(result.testResults)
        && result.testResults.some(test => test && test.passed === false);
      const shouldBail = bail === true && (result.error || hasFailedTests);
      if (shouldBail) {
        runState.stopped = true;
        stopped = true;
        break outer;
      }

      if (conditionalExecution !== false && result.nextRequestById !== undefined) {
        if (result.nextRequestById !== null) {
          const targetIdx = requestIdToIndex.has(result.nextRequestById) ? requestIdToIndex.get(result.nextRequestById) : -1;
          if (targetIdx >= 0) {
            const targetName = requests[targetIdx].name;
            if (iterationRecord) {
              iterationRecord.jumps = [
                ...(iterationRecord.jumps || []),
                { afterName: item.name, to: targetName, via: 'id', targetId: result.nextRequestById },
              ];
            }
            sendEvent('next-request', { from: item.name, to: targetName, via: 'id', targetId: result.nextRequestById });
            if (delayMs > 0 && (await awaitDelay(runState, delayMs)) === 'stopped') {
              stopped = true;
              break outer;
            }
            reqIdx = targetIdx;
            continue;
          }

          const flowRecord = { from: item.name, via: 'id', reason: 'target-not-found', attemptedTarget: result.nextRequestById };
          if (iterationRecord) {
            iterationRecord.conditionalFlowRecords = [
              ...(iterationRecord.conditionalFlowRecords || []),
              { afterName: item.name, via: 'id', reason: 'target-not-found', attemptedTarget: result.nextRequestById },
            ];
          }
          sendEvent('conditional-flow', flowRecord);
          break;
        }

        if (iterationRecord) {
          iterationRecord.conditionalFlowRecords = [
            ...(iterationRecord.conditionalFlowRecords || []),
            { afterName: item.name, via: 'id', reason: 'stopped-by-script' },
          ];
        }
        sendEvent('conditional-flow', { from: item.name, via: 'id', reason: 'stopped-by-script' });
        break;
      }

      if (conditionalExecution !== false && result.nextRequest !== undefined) {
        if (result.nextRequest !== null) {
          const forwardIdx = requests.findIndex((request, index) => index > reqIdx && request.name === result.nextRequest);
          const targetIdx = forwardIdx >= 0
            ? forwardIdx
            : requests.findIndex(request => request.name === result.nextRequest);
          if (targetIdx >= 0) {
            if (iterationRecord) {
              iterationRecord.jumps = [
                ...(iterationRecord.jumps || []),
                { afterName: item.name, to: result.nextRequest, via: 'name' },
              ];
            }
            sendEvent('next-request', { from: item.name, to: result.nextRequest, via: 'name' });
            if (delayMs > 0 && (await awaitDelay(runState, delayMs)) === 'stopped') {
              stopped = true;
              break outer;
            }
            reqIdx = targetIdx;
            continue;
          }

          if (iterationRecord) {
            iterationRecord.conditionalFlowRecords = [
              ...(iterationRecord.conditionalFlowRecords || []),
              { afterName: item.name, via: 'name', reason: 'target-not-found', attemptedTarget: result.nextRequest },
            ];
          }
          sendEvent('conditional-flow', { from: item.name, via: 'name', reason: 'target-not-found', attemptedTarget: result.nextRequest });
          break;
        }

        if (iterationRecord) {
          iterationRecord.conditionalFlowRecords = [
            ...(iterationRecord.conditionalFlowRecords || []),
            { afterName: item.name, via: 'name', reason: 'stopped-by-script' },
          ];
        }
        sendEvent('conditional-flow', { from: item.name, via: 'name', reason: 'stopped-by-script' });
        break;
      }

      if (delayMs > 0 && (await awaitDelay(runState, delayMs)) === 'stopped') {
        stopped = true;
        break outer;
      }

      reqIdx++;
    }

    sendEvent('iteration-end', { iteration: i + 1 });
  }

  if (stopped) sendEvent('stopped', {});
  else sendEvent('done', {});

  return { runId, iterations, errors, stopped };
}

module.exports = {
  InputError,
  prepareCollectionRun,
  executePreparedCollectionRun,
  resolveSchemaLink,
  buildSchemaTest,
  effectiveSchemaMode,
  normalizeSchemaMode,
  SCHEMA_MODES,
};