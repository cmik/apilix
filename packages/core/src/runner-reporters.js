'use strict';

function summarizeRun(iterations) {
  let requests = 0;
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;

  for (const iteration of iterations || []) {
    for (const result of iteration.results || []) {
      requests++;
      if (result.error) errors++;
      for (const test of result.testResults || []) {
        if (test.skipped) skipped++;
        else if (test.passed === true) passed++;
        else if (test.passed === false) failed++;
      }

      for (const child of [...(result.preChildRequests || []), ...(result.testChildRequests || [])]) {
        requests++;
        if (child.result.error) errors++;
        for (const test of child.result.testResults || []) {
          if (test.skipped) skipped++;
          else if (test.passed === true) passed++;
          else if (test.passed === false) failed++;
        }
      }
    }
  }

  return { requests, passed, failed, errors, skipped };
}

function buildJsonReport({
  version,
  runId,
  startedAt,
  finishedAt,
  collectionName,
  environmentName,
  summary,
  iterations,
  errors,
  stopped,
  config,
}) {
  return {
    schemaVersion: 1,
    tool: 'apilix',
    version,
    runId,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
    collectionName,
    environmentName,
    stopped,
    summary,
    errors,
    config,
    iterations,
  };
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toSeconds(ms) {
  return (Math.max(0, Number(ms) || 0) / 1000).toFixed(3);
}

function buildCaseXml(testCase) {
  const lines = [
    `<testcase name="${xmlEscape(testCase.name)}" classname="${xmlEscape(testCase.classname)}" time="${toSeconds(testCase.timeMs)}">`,
  ];

  if (testCase.skipped) {
    lines.push('  <skipped/>');
  } else if (testCase.failureMessage) {
    lines.push(`  <failure message="${xmlEscape(testCase.failureMessage)}">${xmlEscape(testCase.failureBody || testCase.failureMessage)}</failure>`);
  } else if (testCase.errorMessage) {
    lines.push(`  <error message="${xmlEscape(testCase.errorMessage)}">${xmlEscape(testCase.errorBody || testCase.errorMessage)}</error>`);
  }

  lines.push('</testcase>');
  return lines.join('\n');
}

function buildJUnitReport({ collectionName, iterations, errors }) {
  const suites = [];

  for (const iteration of iterations || []) {
    const testCases = [];

    for (const result of iteration.results || []) {
      const retrySuffix = result.retryAttempts > 0 ? ` (retried ×${result.retryAttempts})` : '';
      const executionClass = `iteration.${iteration.iteration}.${result.name}${retrySuffix}`;
      testCases.push({
        name: `[request] ${result.method} ${result.name}`,
        classname: executionClass,
        timeMs: result.responseTime,
        errorMessage: result.error,
        errorBody: result.error || result.body || '',
      });

      for (const test of result.testResults || []) {
        testCases.push({
          name: `[test] ${result.name} :: ${test.name}`,
          classname: executionClass,
          timeMs: result.responseTime,
          skipped: test.skipped === true,
          failureMessage: test.passed === false ? (test.error || 'Assertion failed') : '',
          failureBody: test.error || '',
        });
      }

      for (const child of [...(result.preChildRequests || []), ...(result.testChildRequests || [])]) {
        const childClass = `${executionClass}.${child.name}`;
        testCases.push({
          name: `[child-request] ${child.method} ${child.name}`,
          classname: childClass,
          timeMs: child.result.responseTime,
          errorMessage: child.result.error,
          errorBody: child.result.error || child.result.body || '',
        });
        for (const test of child.result.testResults || []) {
          testCases.push({
            name: `[child-test] ${child.name} :: ${test.name}`,
            classname: childClass,
            timeMs: child.result.responseTime,
            skipped: test.skipped === true,
            failureMessage: test.passed === false ? (test.error || 'Assertion failed') : '',
            failureBody: test.error || '',
          });
        }
      }
    }

    suites.push({
      name: `Iteration ${iteration.iteration}`,
      testCases,
      timeMs: testCases.reduce((total, testCase) => total + (Number(testCase.timeMs) || 0), 0),
    });
  }

  if (Array.isArray(errors) && errors.length > 0) {
    suites.push({
      name: 'Run Errors',
      timeMs: 0,
      testCases: errors.map((error, index) => ({
        name: `Run error ${index + 1}`,
        classname: 'run',
        timeMs: 0,
        errorMessage: error,
        errorBody: error,
      })),
    });
  }

  const totals = suites.reduce((acc, suite) => {
    const tests = suite.testCases.length;
    const failures = suite.testCases.filter(testCase => testCase.failureMessage).length;
    const suiteErrors = suite.testCases.filter(testCase => testCase.errorMessage).length;
    const skipped = suite.testCases.filter(testCase => testCase.skipped).length;
    return {
      tests: acc.tests + tests,
      failures: acc.failures + failures,
      errors: acc.errors + suiteErrors,
      skipped: acc.skipped + skipped,
      timeMs: acc.timeMs + suite.timeMs,
    };
  }, { tests: 0, failures: 0, errors: 0, skipped: 0, timeMs: 0 });

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xmlEscape(collectionName || 'Apilix Run')}" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" skipped="${totals.skipped}" time="${toSeconds(totals.timeMs)}">`,
  ];

  for (const suite of suites) {
    const tests = suite.testCases.length;
    const failures = suite.testCases.filter(testCase => testCase.failureMessage).length;
    const suiteErrors = suite.testCases.filter(testCase => testCase.errorMessage).length;
    const skipped = suite.testCases.filter(testCase => testCase.skipped).length;
    lines.push(`  <testsuite name="${xmlEscape(suite.name)}" tests="${tests}" failures="${failures}" errors="${suiteErrors}" skipped="${skipped}" time="${toSeconds(suite.timeMs)}">`);
    for (const testCase of suite.testCases) {
      const caseXml = buildCaseXml(testCase).split('\n').map(line => `    ${line}`);
      lines.push(...caseXml);
    }
    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');
  return lines.join('\n');
}

module.exports = {
  summarizeRun,
  buildJsonReport,
  buildJUnitReport,
};