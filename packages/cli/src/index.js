'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const Chalk = require('chalk');
const { Command } = require('commander');

const pkg = require('../package.json');
const { setExecutorConfig, prepareCollectionRun, executePreparedCollectionRun, summarizeRun, buildJsonReport, buildJUnitReport } = require('@apilix/core');

const DEFAULT_REQUEST_TIMEOUT = 30000;
const MAX_REQUEST_NAME_WIDTH = 72;

function usage() {
  return [
    'Usage:',
    '  apilix run <collection-file> [options]',
    '  apilix run --collection <collection-file> [options]',
    '',
    'Options:',
    '  -e, --environment <file>     Environment JSON file with values[]',
    '  --globals <file>             Globals JSON file or key/value map',
    '  --collection-vars <file>     Collection variables JSON file or key/value map',
    '  --csv <file>                 CSV data file for per-row iterations',
    '  --iterations <n>             Iteration count when CSV is not provided (max 100 without CSV)',
    '  --delay <ms>                 Delay between requests (max 5000)',
    '  --execute-child-requests     Allow apx.sendRequest()/pm.sendRequest() child calls',
    '  --no-conditional-execution   Disable setNextRequest() flow overrides',
    '  --reporter <table|json|junit|both>  Output format (default: table)',
    '  --out <file>                 Output file for a single json/junit reporter',
    '  --out-dir <dir>              Output directory for json/junit artifacts',
    '  --timeout <ms>               Request timeout in milliseconds (default: 30000)',
    '  --http-proxy <url>           HTTP proxy URL (e.g., http://proxy.example.com:8080)',
    '  --https-proxy <url>          HTTPS proxy URL (e.g., http://proxy.example.com:8080)',
    '  --proxy-bypass <hosts>       Comma-separated hosts to bypass proxy (e.g., localhost,127.0.0.1)',
    '  --bail                       Stop execution on first test failure or request error',
    '  --ssl-verification           Enable TLS certificate verification',
    '  --no-follow-redirects        Disable automatic redirect following',
    '  --no-color                   Disable ANSI colors in terminal output',
    '  -h, --help                   Show this help',
  ].join('\n');
}

function createIo(overrides = {}) {
  return {
    cwd: overrides.cwd || process.cwd(),
    stdout: overrides.stdout || process.stdout,
    stderr: overrides.stderr || process.stderr,
  };
}

function resolvePath(io, filePath) {
  return path.resolve(io.cwd, filePath);
}

async function readJsonFile(io, filePath, label) {
  const absolutePath = resolvePath(io, filePath);
  let text;
  try {
    text = await fs.readFile(absolutePath, 'utf8');
  } catch {
    throw new Error(`Unable to read ${label} file: ${absolutePath}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${label} file: ${absolutePath}`);
  }
}

async function readTextFile(io, filePath, label) {
  const absolutePath = resolvePath(io, filePath);
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch {
    throw new Error(`Unable to read ${label} file: ${absolutePath}`);
  }
}

function valuesArrayToMap(values) {
  return values.reduce((acc, entry) => {
    if (!entry || typeof entry.key !== 'string' || entry.key.length === 0) return acc;
    if (entry.enabled === false || entry.disabled === true) return acc;
    acc[entry.key] = entry.value == null ? '' : String(entry.value);
    return acc;
  }, {});
}

function normalizeCollection(input) {
  const collection = input && input.collection && input.collection.item ? input.collection : input;
  if (!collection || !collection.info || !Array.isArray(collection.item)) {
    throw new Error('Collection file must contain a Postman/Apilix collection with info and item[]');
  }
  return collection;
}

function normalizeVariableMap(input, label) {
  if (input == null) return {};

  if (Array.isArray(input.values)) return valuesArrayToMap(input.values);
  if (Array.isArray(input.variable)) return valuesArrayToMap(input.variable);

  if (typeof input === 'object' && !Array.isArray(input)) {
    return Object.entries(input).reduce((acc, entry) => {
      const key = entry[0];
      const value = entry[1];
      if (value === undefined) return acc;
      acc[key] = value == null ? '' : String(value);
      return acc;
    }, {});
  }

  throw new Error(`${label} file must be an object map or contain values[]/variable[]`);
}

function normalizeEnvironment(input) {
  if (input == null) return { name: null, vars: {} };
  const environment = input && input.environment && input.environment.values ? input.environment : input;
  if (environment && Array.isArray(environment.values)) {
    return { name: environment.name || null, vars: valuesArrayToMap(environment.values) };
  }
  return { name: null, vars: normalizeVariableMap(environment, 'environment') };
}

function ensureReporter(value) {
  if (!['table', 'json', 'junit', 'both'].includes(value)) {
    throw new Error('Reporter must be one of: table, json, junit, both');
  }
  return value;
}

function createProgram(io) {
  const parsed = {
    command: null,
    help: false,
    reporter: 'table',
    followRedirects: true,
    conditionalExecution: true,
    executeChildRequests: false,
    sslVerification: false,
    color: true,
    timeout: DEFAULT_REQUEST_TIMEOUT,
    httpProxy: '',
    httpsProxy: '',
    proxyBypass: '',
    bail: false,
  };

  const program = new Command();
  program
    .name('apilix')
    .description('Apilix CLI runner')
    .showHelpAfterError()
    .configureOutput({
      writeOut: chunk => io.stdout.write(chunk),
      writeErr: chunk => io.stderr.write(chunk),
    })
    .exitOverride();

  program
    .command('run [collectionPath]')
    .description('Execute a Postman/Apilix collection file')
    .option('--collection <file>', 'Collection JSON file (legacy alternative to positional argument)')
    .option('-e, --environment <file>', 'Environment JSON file with values[]')
    .option('--globals <file>', 'Globals JSON file or key/value map')
    .option('--collection-vars <file>', 'Collection variables JSON file or key/value map')
    .option('--csv <file>', 'CSV data file for per-row iterations')
    .option('--iterations <n>', 'Iteration count when CSV is not provided')
    .option('--delay <ms>', 'Delay between requests (max 5000)')
    .option('--execute-child-requests', 'Allow apx.sendRequest()/pm.sendRequest() child calls')
    .option('--no-conditional-execution', 'Disable setNextRequest() flow overrides')
    .option('--reporter <table|json|junit|both>', 'Output format', 'table')
    .option('--out <file>', 'Output file for a single json/junit reporter')
    .option('--out-dir <dir>', 'Output directory for json/junit artifacts')
    .option('--timeout <ms>', 'Request timeout in milliseconds', String(DEFAULT_REQUEST_TIMEOUT))
    .option('--http-proxy <url>', 'HTTP proxy URL (e.g., http://proxy.example.com:8080)')
    .option('--https-proxy <url>', 'HTTPS proxy URL (e.g., http://proxy.example.com:8080)')
    .option('--proxy-bypass <hosts>', 'Comma-separated hosts to bypass proxy (e.g., localhost,127.0.0.1)')
    .option('--bail', 'Stop execution on first test failure or request error')
    .option('--ssl-verification', 'Enable TLS certificate verification')
    .option('--no-follow-redirects', 'Disable automatic redirect following')
    .option('--no-color', 'Disable ANSI colors in terminal output')
    .action((collectionPath, opts) => {
      parsed.command = 'run';
      parsed.collectionPath = collectionPath || opts.collection;
      parsed.usedLegacyCollectionFlag = !collectionPath && !!opts.collection;
      parsed.environmentPath = opts.environment;
      parsed.globalsPath = opts.globals;
      parsed.collectionVarsPath = opts.collectionVars;
      parsed.csvPath = opts.csv;
      parsed.iterations = opts.iterations;
      parsed.delay = opts.delay;
      parsed.reporter = opts.reporter;
      parsed.outPath = opts.out;
      parsed.outDir = opts.outDir;
      parsed.timeout = opts.timeout;
      parsed.httpProxy = opts.httpProxy || '';
      parsed.httpsProxy = opts.httpsProxy || '';
      parsed.proxyBypass = opts.proxyBypass || '';
      parsed.bail = opts.bail === true;
      parsed.followRedirects = opts.followRedirects !== false;
      parsed.conditionalExecution = opts.conditionalExecution !== false;
      parsed.executeChildRequests = opts.executeChildRequests === true;
      parsed.sslVerification = opts.sslVerification === true;
      parsed.color = opts.color !== false;
    });

  return { program, parsed };
}

function parseArgs(argv, ioOverrides = {}) {
  const io = createIo(ioOverrides);
  const { program, parsed } = createProgram(io);

  if (!Array.isArray(argv) || argv.length === 0) {
    parsed.help = true;
    return parsed;
  }

  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    if (error && error.code === 'commander.helpDisplayed') {
      parsed.help = true;
      parsed.helpRendered = true;
      return parsed;
    }
    throw new Error(error && error.message ? error.message.replace(/^error:\s*/i, '') : 'Invalid CLI arguments');
  }

  if (!parsed.command && argv.includes('--help')) {
    parsed.help = true;
  }

  return parsed;
}

function assertionStatus(result) {
  if (result.error) return 'FAIL';
  const tests = result.testResults || [];
  if (tests.some(test => test && test.passed === false)) return 'FAIL';
  if (tests.length === 0) return 'N/A';
  return 'PASS';
}

function pushRows(rows, result, namePrefix) {
  rows.push({
    requestName: `${namePrefix}${result.name}`,
    statusCode: result.status,
    responseTime: `${Math.max(0, Number(result.responseTime) || 0)} ms`,
    assertion: assertionStatus(result),
  });

  const children = []
    .concat(result.preChildRequests || [])
    .concat(result.testChildRequests || []);

  for (const child of children) {
    const childResult = {
      name: child.name,
      status: child.result && child.result.status,
      responseTime: child.result && child.result.responseTime,
      testResults: child.result && child.result.testResults,
      error: child.result && child.result.error,
      preChildRequests: [],
      testChildRequests: [],
    };
      pushRows(rows, childResult, '  -> ');
  }
}

function formatTable(rows, chalk) {
  const clippedRows = rows.map(row => {
    const requestName = String(row.requestName || '');
    if (requestName.length <= MAX_REQUEST_NAME_WIDTH) return row;
    return {
      ...row,
      requestName: `${requestName.slice(0, Math.max(0, MAX_REQUEST_NAME_WIDTH - 3))}...`,
    };
  });

  const headers = {
    requestName: 'Request Name',
    statusCode: 'Status Code',
    responseTime: 'Response Time',
    assertion: 'Assertions',
  };

  const widths = {
    requestName: headers.requestName.length,
    statusCode: headers.statusCode.length,
    responseTime: headers.responseTime.length,
    assertion: headers.assertion.length,
  };

  for (const row of clippedRows) {
    widths.requestName = Math.max(widths.requestName, String(row.requestName).length);
    widths.statusCode = Math.max(widths.statusCode, String(row.statusCode).length);
    widths.responseTime = Math.max(widths.responseTime, String(row.responseTime).length);
    widths.assertion = Math.max(widths.assertion, String(row.assertion).length);
  }

  const divider = `+-${'-'.repeat(widths.requestName)}-+-${'-'.repeat(widths.statusCode)}-+-${'-'.repeat(widths.responseTime)}-+-${'-'.repeat(widths.assertion)}-+`;

  const headerLine = `| ${headers.requestName.padEnd(widths.requestName)} | ${headers.statusCode.padEnd(widths.statusCode)} | ${headers.responseTime.padEnd(widths.responseTime)} | ${headers.assertion.padEnd(widths.assertion)} |`;

  const lines = [divider, chalk.bold(headerLine), divider];

  for (const row of clippedRows) {
    const assertionText = row.assertion === 'PASS'
      ? chalk.green(row.assertion)
      : (row.assertion === 'FAIL' ? chalk.red(row.assertion) : chalk.yellow(row.assertion));

    const statusCode = Number(row.statusCode) >= 400
      ? chalk.red(String(row.statusCode))
      : chalk.green(String(row.statusCode));

    lines.push(
      `| ${String(row.requestName).padEnd(widths.requestName)} | ${statusCode.padEnd(widths.statusCode + (statusCode.length - String(row.statusCode).length))} | ${String(row.responseTime).padEnd(widths.responseTime)} | ${assertionText.padEnd(widths.assertion + (assertionText.length - String(row.assertion).length))} |`
    );
  }

  lines.push(divider);
  return lines.join('\n');
}

function buildSummaryTable(iterations, useColor, outputStream) {
  const rows = [];
  const stream = outputStream || process.stderr;
  const level = useColor === false ? 0 : (stream.isTTY ? 1 : 0);
  const chalk = new Chalk.Instance({ level });

  for (const iteration of iterations || []) {
    for (const result of iteration.results || []) {
      pushRows(rows, result, '');
    }
  }

  if (rows.length === 0) {
    return chalk.yellow('No requests were executed.');
  }

  return formatTable(rows, chalk);
}

async function writeOutputFile(targetPath, content) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, 'utf8');
}

function buildExitCode(summary, runErrors) {
  if (summary.failed > 0 || summary.errors > 0 || (runErrors || []).length > 0) return 1;
  return 0;
}

async function runCli(argv, ioOverrides = {}) {
  const io = createIo(ioOverrides);

  try {
    const args = parseArgs(argv, io);
    if (args.help || !args.command) {
      if (!args.helpRendered) io.stdout.write(`${usage()}\n`);
      return 0;
    }

    if (args.command !== 'run') {
      throw new Error(`Unknown command: ${args.command}`);
    }

    if (!args.collectionPath) {
      throw new Error('The collection path is required');
    }

    const reporter = ensureReporter(args.reporter);
    if (reporter === 'both' && !args.outDir) {
      throw new Error('The --out-dir option is required when --reporter both is used');
    }
    if (args.outPath && args.outDir) {
      throw new Error('Use either --out or --out-dir, not both');
    }
    if (args.outPath && reporter === 'both') {
      throw new Error('The --out option only supports a single reporter; use --out-dir for reporter=both');
    }
    if (reporter === 'table' && (args.outPath || args.outDir)) {
      throw new Error('The table reporter writes to terminal only; remove --out/--out-dir or choose json/junit/both');
    }

    const collectionJson = await readJsonFile(io, args.collectionPath, 'collection');
    const environmentJson = args.environmentPath
      ? await readJsonFile(io, args.environmentPath, 'environment')
      : null;
    const globalsJson = args.globalsPath
      ? await readJsonFile(io, args.globalsPath, 'globals')
      : null;
    const collectionVarsJson = args.collectionVarsPath
      ? await readJsonFile(io, args.collectionVarsPath, 'collection variables')
      : null;
    const csvText = args.csvPath
      ? await readTextFile(io, args.csvPath, 'csv')
      : null;

    const collection = normalizeCollection(collectionJson);
    const environment = normalizeEnvironment(environmentJson);
    const globals = normalizeVariableMap(globalsJson, 'globals');
    const collectionVariables = normalizeVariableMap(collectionVarsJson, 'collection variables');

    const rawTimeout = parseInt(args.timeout, 10);
    const timeout = Number.isNaN(rawTimeout) ? DEFAULT_REQUEST_TIMEOUT : Math.max(0, rawTimeout);
    setExecutorConfig({
      followRedirects: args.followRedirects !== false,
      requestTimeout: timeout,
      sslVerification: args.sslVerification === true,
      proxyEnabled: !!(args.httpProxy || args.httpsProxy),
      httpProxy: args.httpProxy || '',
      httpsProxy: args.httpsProxy || '',
      noProxy: args.proxyBypass || '',
    });

    const payload = {
      collection,
      environment: environment.vars,
      collectionVariables,
      globals,
      cookies: {},
      delay: Math.max(0, parseInt(args.delay, 10) || 0),
      iterations: Math.max(1, parseInt(args.iterations, 10) || 1),
      executeChildRequests: args.executeChildRequests === true,
      conditionalExecution: args.conditionalExecution !== false,
      bail: args.bail === true,
      allCollectionItems: collection.item,
      mockBase: null,
    };

    const startedAt = new Date().toISOString();
    const prepared = prepareCollectionRun(payload, { csvText });
    const run = await executePreparedCollectionRun(prepared);
    const finishedAt = new Date().toISOString();
    const summary = summarizeRun(run.iterations);

    const table = buildSummaryTable(run.iterations, args.color !== false, io.stderr);
    io.stderr.write(`${table}\n`);

    // Surface per-request warnings (unsupported auth, formdata file fields, etc.)
    const runWarnings = [];
    for (const iter of run.iterations || []) {
      for (const result of iter.results || []) {
        for (const w of result.warnings || []) {
          if (!runWarnings.includes(w)) runWarnings.push(w);
        }
      }
    }
    if (runWarnings.length > 0) {
      io.stderr.write(`\nWarnings (${runWarnings.length}):\n`);
      for (const w of runWarnings) io.stderr.write(`  ! ${w}\n`);
      io.stderr.write('\n');
    }

    const jsonReport = buildJsonReport({
      version: pkg.version,
      runId: run.runId,
      startedAt,
      finishedAt,
      collectionName: collection.info.name,
      environmentName: environment.name,
      summary,
      iterations: run.iterations,
      errors: run.errors,
      stopped: run.stopped,
      config: {
        collectionPath: path.relative(io.cwd, resolvePath(io, args.collectionPath)),
        environmentPath: args.environmentPath ? path.relative(io.cwd, resolvePath(io, args.environmentPath)) : null,
        globalsPath: args.globalsPath ? path.relative(io.cwd, resolvePath(io, args.globalsPath)) : null,
        collectionVarsPath: args.collectionVarsPath ? path.relative(io.cwd, resolvePath(io, args.collectionVarsPath)) : null,
        csvPath: args.csvPath ? path.relative(io.cwd, resolvePath(io, args.csvPath)) : null,
        iterations: payload.iterations,
        delay: payload.delay,
        executeChildRequests: payload.executeChildRequests,
        conditionalExecution: payload.conditionalExecution,
        timeout,
        followRedirects: args.followRedirects !== false,
        sslVerification: args.sslVerification === true,
      },
    });

    const junitReport = buildJUnitReport({
      collectionName: collection.info.name,
      iterations: run.iterations,
      errors: run.errors,
    });

    if (reporter === 'json') {
      const content = `${JSON.stringify(jsonReport, null, 2)}\n`;
      if (args.outPath) {
        await writeOutputFile(resolvePath(io, args.outPath), content);
      } else if (args.outDir) {
        await writeOutputFile(path.join(resolvePath(io, args.outDir), 'apilix-run.json'), content);
      } else {
        io.stdout.write(content);
      }
    } else if (reporter === 'junit') {
      if (args.outPath) {
        await writeOutputFile(resolvePath(io, args.outPath), `${junitReport}\n`);
      } else if (args.outDir) {
        await writeOutputFile(path.join(resolvePath(io, args.outDir), 'apilix-run.junit.xml'), `${junitReport}\n`);
      } else {
        io.stdout.write(`${junitReport}\n`);
      }
    } else if (reporter === 'both') {
      const outDir = resolvePath(io, args.outDir);
      await writeOutputFile(path.join(outDir, 'apilix-run.json'), `${JSON.stringify(jsonReport, null, 2)}\n`);
      await writeOutputFile(path.join(outDir, 'apilix-run.junit.xml'), `${junitReport}\n`);
    }

    io.stderr.write(
      `Run complete: ${summary.requests} requests, ${summary.passed} passed, ${summary.failed} failed, ${summary.errors} request errors${run.errors.length ? `, ${run.errors.length} run errors` : ''}.\n`
    );

    return buildExitCode(summary, run.errors);
  } catch (error) {
    io.stderr.write(`Error: ${error.message}\n`);
    io.stderr.write(`${usage()}\n`);
    return 2;
  }
}

module.exports = {
  runCli,
  parseArgs,
  usage,
  buildSummaryTable,
};
