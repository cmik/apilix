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
  const mongoOperation = item.request?.mongodb?.operation || result.mongoOperation;
  const methodLabel = isMongo ? `MONGO:${String(mongoOperation || 'op').toUpperCase()}` : (item.request?.method || 'GET');
  return {
    iteration,
    name: item.name,
    method: methodLabel,
    protocol: isMongo ? 'mongodb' : 'http',
    mongoOperation,
    mongoStatus: result.mongoStatus,
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
  } = payload;
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
          });
          if (result.updatedEnvironment) currentEnv = result.updatedEnvironment;
          if (result.updatedCollectionVariables) currentCollVars = result.updatedCollectionVariables;
          if (result.updatedGlobals) currentGlobals = result.updatedGlobals;
          if (result.updatedCookies) currentCookies = result.updatedCookies;
        }
      }
      result._retryAttempts = retryAttempts;

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
};