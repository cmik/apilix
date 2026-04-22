'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const pkg = require('../package.json');
const { setExecutorConfig } = require('./executor');
const { prepareCollectionRun, executePreparedCollectionRun } = require('./collectionRunner');
const { summarizeRun, buildJsonReport, buildJUnitReport } = require('./runnerReporters');

const DEFAULT_REQUEST_TIMEOUT = 30000;

function usage() {
  return [
    'Usage:',
    '  apilix run --collection <file> [options]',
    '',
    'Options:',
    '  --collection <file>         Postman/Apilix collection JSON file',
    '  --environment <file>        Environment JSON file with values[]',
    '  --globals <file>            Globals JSON file or key/value map',
    '  --collection-vars <file>    Collection variables JSON file or key/value map',
    '  --csv <file>                CSV data file for per-row iterations',
    '  --iterations <n>            Iteration count when CSV is not provided',
    '  --delay <ms>                Delay between requests (max 5000)',
    '  --execute-child-requests    Allow apx.sendRequest()/pm.sendRequest() child calls',
    '  --no-conditional-execution  Disable setNextRequest() flow overrides',
    '  --reporter <json|junit|both> Report output format (default: json)',
    '  --out <file>                Output file for a single reporter',
    '  --out-dir <dir>             Output directory; writes apilix-run.json and/or apilix-run.junit.xml',
    '  --timeout <ms>              Request timeout in milliseconds (default: 30000)',
    '  --ssl-verification          Enable TLS certificate verification',
    '  --no-follow-redirects       Disable automatic redirect following',
    '  -h, --help                  Show this help',
  ].join('\n');
}

function createIo(overrides = {}) {
  return {
    cwd: overrides.cwd || process.cwd(),
    stdout: overrides.stdout || process.stdout,
    stderr: overrides.stderr || process.stderr,
  };
}

function parseArgs(argv) {
  const args = {
    command: null,
    help: false,
    reporter: 'json',
    followRedirects: true,
    conditionalExecution: true,
    executeChildRequests: false,
    sslVerification: false,
    timeout: DEFAULT_REQUEST_TIMEOUT,
  };

  const valueFlags = new Set([
    '--collection',
    '--environment',
    '--globals',
    '--collection-vars',
    '--csv',
    '--iterations',
    '--delay',
    '--reporter',
    '--out',
    '--out-dir',
    '--timeout',
  ]);

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];

    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }

    if (!args.command && !token.startsWith('-')) {
      args.command = token;
      continue;
    }

    if (valueFlags.has(token)) {
      if (index + 1 >= argv.length) {
        throw new Error(`Missing value for ${token}`);
      }
      const value = argv[++index];
      switch (token) {
        case '--collection': args.collectionPath = value; break;
        case '--environment': args.environmentPath = value; break;
        case '--globals': args.globalsPath = value; break;
        case '--collection-vars': args.collectionVarsPath = value; break;
        case '--csv': args.csvPath = value; break;
        case '--iterations': args.iterations = value; break;
        case '--delay': args.delay = value; break;
        case '--reporter': args.reporter = value; break;
        case '--out': args.outPath = value; break;
        case '--out-dir': args.outDir = value; break;
        case '--timeout': args.timeout = value; break;
        default: break;
      }
      continue;
    }

    switch (token) {
      case '--execute-child-requests':
        args.executeChildRequests = true;
        break;
      case '--no-conditional-execution':
        args.conditionalExecution = false;
        break;
      case '--ssl-verification':
        args.sslVerification = true;
        break;
      case '--no-follow-redirects':
        args.followRedirects = false;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function resolvePath(io, filePath) {
  return path.resolve(io.cwd, filePath);
}

async function readJsonFile(io, filePath, label) {
  const absolutePath = resolvePath(io, filePath);
  let text;
  try {
    text = await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${label} file: ${absolutePath}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} file: ${absolutePath}`);
  }
}

async function readTextFile(io, filePath, label) {
  const absolutePath = resolvePath(io, filePath);
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${label} file: ${absolutePath}`);
  }
}

function normalizeCollection(input) {
  const collection = input?.collection && input.collection.item ? input.collection : input;
  if (!collection || !collection.info || !Array.isArray(collection.item)) {
    throw new Error('Collection file must contain a Postman/Apilix collection with info and item[]');
  }
  return collection;
}

function valuesArrayToMap(values) {
  return values.reduce((acc, entry) => {
    if (!entry || typeof entry.key !== 'string' || entry.key.length === 0) return acc;
    if (entry.enabled === false || entry.disabled === true) return acc;
    acc[entry.key] = entry.value == null ? '' : String(entry.value);
    return acc;
  }, {});
}

function normalizeVariableMap(input, label) {
  if (input == null) return {};

  if (Array.isArray(input.values)) return valuesArrayToMap(input.values);
  if (Array.isArray(input.variable)) return valuesArrayToMap(input.variable);

  if (typeof input === 'object' && !Array.isArray(input)) {
    return Object.entries(input).reduce((acc, [key, value]) => {
      if (value === undefined) return acc;
      acc[key] = value == null ? '' : String(value);
      return acc;
    }, {});
  }

  throw new Error(`${label} file must be an object map or contain values[]/variable[]`);
}

function normalizeEnvironment(input) {
  if (input == null) return { name: null, vars: {} };
  const environment = input?.environment && input.environment.values ? input.environment : input;
  if (environment && Array.isArray(environment.values)) {
    return { name: environment.name || null, vars: valuesArrayToMap(environment.values) };
  }
  return { name: null, vars: normalizeVariableMap(environment, 'environment') };
}

function ensureReporter(value) {
  if (!['json', 'junit', 'both'].includes(value)) {
    throw new Error('Reporter must be one of: json, junit, both');
  }
  return value;
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
    const args = parseArgs(argv);
    if (args.help || !args.command) {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }

    if (args.command !== 'run') {
      throw new Error(`Unknown command: ${args.command}`);
    }

    if (!args.collectionPath) {
      throw new Error('The --collection option is required');
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
      allCollectionItems: collection.item,
      mockBase: null,
    };

    const startedAt = new Date().toISOString();
    const prepared = prepareCollectionRun(payload, { csvText });
    const run = await executePreparedCollectionRun(prepared);
    const finishedAt = new Date().toISOString();
    const summary = summarizeRun(run.iterations);
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
    } else {
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
};