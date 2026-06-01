'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const Chalk = require('chalk');
const { Command } = require('commander');

const pkg = require('../package.json');
const {
  setExecutorConfig,
  prepareCollectionRun,
  executePreparedCollectionRun,
  summarizeRun,
  buildJsonReport,
  buildJUnitReport,
  resolveVariables,
} = require('@apilix/core');

const DEFAULT_REQUEST_TIMEOUT = 30000;
const MAX_REQUEST_NAME_WIDTH = 72;
const SUPPORTED_DATABASE_TYPES = new Set([
  'mysql',
  'postgres',
  'mongodb',
  'sqlite',
  'cassandra',
  'oracle',
  'mssql',
  'redis',
  'dynamodb',
]);

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
    '  --databases <file>           Database connections JSON file (array or { databases: [] })',
    '  --csv <file>                 CSV data file for per-row iterations',
    '  --data <file>                JSON data file (array of objects) for per-row iterations',
    '  --iterations <n>             Iteration count when no data file is provided (max 100)',
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
    '  --retry <n>                  Max retries per request on failure (0–10, default 0)',
    '  --retry-delay <ms>           Base delay between retries in ms (default 1000)',
    '  --retry-backoff <fixed|exponential>  Backoff strategy (default: fixed)',
    '  --retry-on <failures|errors|both>    What triggers a retry (default: both)',
    '  --mongo-uri <uri>            Override MongoDB URI for mongodb requests',
    '  --mongo-db <db>              Override MongoDB database for mongodb requests',
    '  --ssl-verification           Enable TLS certificate verification',
    '  --ca-cert <file>             PEM CA certificate(s) to add to the trust store',
    '  --client-cert <file>         PEM client certificate for mTLS',
    '  --client-key <file>          PEM private key for --client-cert',
    '  --client-key-passphrase <pass>  Passphrase for an encrypted --client-key',
    '  --client-cert-host <pattern> Hostname / *.wildcard scope for the client cert (default: * = all hosts)',
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

function normalizeDatabases(input) {
  if (input == null) return [];
  const databases = Array.isArray(input)
    ? input
    : (input && Array.isArray(input.databases) ? input.databases : null);

  if (!databases) {
    throw new Error('databases file must be an array or an object with databases[]');
  }

  return databases.map((db, index) => {
    if (!db || typeof db !== 'object') {
      throw new Error(`databases[${index}] must be an object`);
    }
    const id = typeof db._id === 'string' ? db._id.trim() : '';
    const type = typeof db.type === 'string' ? db.type.trim().toLowerCase() : '';
    if (!id) throw new Error(`databases[${index}] is missing _id`);
    if (!SUPPORTED_DATABASE_TYPES.has(type)) {
      throw new Error(`databases[${index}] has unsupported type "${type}"`);
    }

    if ((type === 'mysql' || type === 'postgres')) {
      if (!db.host || !db.username || !db.database) {
        throw new Error(`databases[${index}] (${type}) must include host, username, and database`);
      }
      const port = Number(db.port ?? (type === 'postgres' ? 5432 : 3306));
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new Error(`databases[${index}] (${type}) has invalid port`);
      }
    }

    if (db.connectionTimeout !== undefined) {
      const timeout = Number(db.connectionTimeout);
      if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) {
        throw new Error(`databases[${index}] connectionTimeout must be an integer between 100 and 120000`);
      }
    }

    if (db.queryTimeout !== undefined) {
      const timeout = Number(db.queryTimeout);
      if (!Number.isInteger(timeout) || timeout < 100 || timeout > 600000) {
        throw new Error(`databases[${index}] queryTimeout must be an integer between 100 and 600000`);
      }
    }

    if (db.maxConnections !== undefined) {
      const maxConnections = Number(db.maxConnections);
      if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 50) {
        throw new Error(`databases[${index}] maxConnections must be an integer between 1 and 50`);
      }
    }

    if (type === 'mongodb' && (!db.connectionUri || typeof db.connectionUri !== 'string')) {
      throw new Error(`databases[${index}] (mongodb) must include connectionUri`);
    }

    return { ...db, type };
  });
}

function buildRuntimeVars(scriptContext, defaultRuntimeVars = {}) {
  const ctx = scriptContext && typeof scriptContext === 'object' ? scriptContext : {};
  return {
    ...defaultRuntimeVars,
    ...(ctx.environment || {}),
    ...(ctx.collectionVariables || {}),
    ...(ctx.globals || {}),
    ...(ctx.dataRow || {}),
  };
}

function resolveDatabaseConfigTemplates(config, runtimeVars) {
  const vars = runtimeVars || {};
  const resolved = { ...config };
  const fields = [
    'host', 'username', 'password', 'database', 'sslCert',
    'connectionUri', 'sslCertPath', 'sslKeyPath', 'sslCAPath',
  ];

  fields.forEach((field) => {
    if (typeof resolved[field] === 'string') {
      resolved[field] = resolveVariables(resolved[field], vars);
    }
  });

  return resolved;
}

function poolKeyFor(connectionId, resolvedConfig) {
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify(resolvedConfig || {}))
    .digest('hex')
    .slice(0, 12);
  return `cli_${connectionId}_${hash}`;
}

function createCliDbQueryFn(databases, defaultRuntimeVars = {}) {
  const sqlPools = new Map(); // poolKey -> { type, client }
  const activePoolByConnection = new Map(); // connectionId -> poolKey

  async function closePool(poolKey) {
    const entry = sqlPools.get(poolKey);
    if (!entry) return;
    try {
      await entry.client.end();
    } finally {
      sqlPools.delete(poolKey);
    }
  }

  async function ensurePool(connectionId, resolvedConfig) {
    const poolKey = poolKeyFor(connectionId, resolvedConfig);
    const existing = activePoolByConnection.get(connectionId);
    if (existing && existing !== poolKey) {
      await closePool(existing);
    }
    activePoolByConnection.set(connectionId, poolKey);
    if (sqlPools.has(poolKey)) return { poolKey, entry: sqlPools.get(poolKey) };

    const timeout = resolvedConfig.connectionTimeout ?? 10000;
    const maxConns = resolvedConfig.maxConnections ?? 5;

    if (resolvedConfig.type === 'mysql') {
      const mysql = require('mysql2/promise');
      const pool = mysql.createPool({
        host: resolvedConfig.host,
        port: resolvedConfig.port ?? 3306,
        user: resolvedConfig.username,
        password: resolvedConfig.password,
        database: resolvedConfig.database,
        ssl: resolvedConfig.ssl ? { rejectUnauthorized: resolvedConfig.sslRejectUnauthorized !== false } : undefined,
        connectTimeout: timeout,
        connectionLimit: maxConns,
        waitForConnections: true,
        enableKeepAlive: true,
      });
      sqlPools.set(poolKey, { type: 'mysql', client: pool, config: resolvedConfig });
    } else if (resolvedConfig.type === 'postgres') {
      const { Pool } = require('pg');
      const pool = new Pool({
        host: resolvedConfig.host,
        port: resolvedConfig.port ?? 5432,
        user: resolvedConfig.username,
        password: resolvedConfig.password,
        database: resolvedConfig.database,
        ssl: resolvedConfig.ssl
          ? {
              rejectUnauthorized: resolvedConfig.sslRejectUnauthorized !== false,
              ca: resolvedConfig.sslCert || undefined,
            }
          : false,
        connectionTimeoutMillis: timeout,
        max: maxConns,
      });
      pool.on('error', (err) => {
        console.error(`[cli-db] Postgres pool error for ${connectionId}:`, err.message);
      });
      sqlPools.set(poolKey, { type: 'postgres', client: pool, config: resolvedConfig });
    } else {
      throw new Error(`Unsupported SQL database type: ${resolvedConfig.type}`);
    }

    return { poolKey, entry: sqlPools.get(poolKey) };
  }

  async function query(connectionId, sql, params = [], scriptContext) {
    if (!Array.isArray(databases) || databases.length === 0) {
      throw new Error('No database connections are configured for this run. Provide --databases <file>.');
    }
    const config = databases.find(d => d && d._id === connectionId);
    if (!config) throw new Error(`Database connection "${connectionId}" not found`);
    if (config.type !== 'mysql' && config.type !== 'postgres') {
      throw new Error(`Database connection "${connectionId}" is not an SQL connection`);
    }

    const runtimeVars = buildRuntimeVars(scriptContext, defaultRuntimeVars);
    const resolvedConfig = resolveDatabaseConfigTemplates(config, runtimeVars);
    const { entry } = await ensurePool(connectionId, resolvedConfig);

    if (entry.type === 'mysql') {
      const [rows] = await entry.client.query({ sql, timeout: entry.config.queryTimeout ?? 30000 }, params);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { rows, columns, rowCount: rows.length };
    }

    const result = await entry.client.query(sql, params);
    const columns = result.fields ? result.fields.map(f => f.name) : [];
    return {
      rows: result.rows,
      columns,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async function closeAll() {
    const keys = [...sqlPools.keys()];
    for (const key of keys) {
      await closePool(key);
    }
  }

  return { query, closeAll };
}

function createCliMongoQueryFn(databases, defaultRuntimeVars = {}) {
  const mongoClients = new Map(); // clientKey -> MongoClient
  const activeClientByConnection = new Map(); // connectionId -> clientKey

  async function closeClient(clientKey) {
    const client = mongoClients.get(clientKey);
    if (!client) return;
    try {
      await client.close();
    } finally {
      mongoClients.delete(clientKey);
    }
  }

  async function ensureClient(connectionId, resolvedConfig) {
    const clientKey = poolKeyFor(connectionId, resolvedConfig);
    const previousKey = activeClientByConnection.get(connectionId);
    if (previousKey && previousKey !== clientKey) {
      await closeClient(previousKey);
    }
    activeClientByConnection.set(connectionId, clientKey);
    if (mongoClients.has(clientKey)) return mongoClients.get(clientKey);

    const { MongoClient } = require('mongodb');
    const timeout = resolvedConfig.connectionTimeout ?? 10000;
    const maxConns = resolvedConfig.maxConnections ?? 5;
    const tlsCertificateKeyFile = resolvedConfig.sslKeyPath || resolvedConfig.sslCertPath || undefined;
    const client = new MongoClient(resolvedConfig.connectionUri, {
      maxPoolSize: maxConns,
      connectTimeoutMS: timeout,
      serverSelectionTimeoutMS: timeout,
      authMechanism: resolvedConfig.authMechanism || undefined,
      tls: resolvedConfig.ssl,
      tlsAllowInvalidCertificates: resolvedConfig.sslRejectUnauthorized === false,
      tlsCAFile: resolvedConfig.sslCAPath || undefined,
      tlsCertificateKeyFile,
    });
    await client.connect();
    mongoClients.set(clientKey, client);
    return client;
  }

  async function mongoQuery(connectionId, operation, document, options = {}, scriptContext) {
    if (!Array.isArray(databases) || databases.length === 0) {
      throw new Error('No database connections are configured for this run. Provide --databases <file>.');
    }
    const config = databases.find(d => d && d._id === connectionId);
    if (!config) throw new Error(`Database connection "${connectionId}" not found`);
    if (config.type !== 'mongodb') {
      throw new Error(`Database connection "${connectionId}" is not a MongoDB connection`);
    }

    const runtimeVars = buildRuntimeVars(scriptContext, defaultRuntimeVars);
    const resolvedConfig = resolveDatabaseConfigTemplates(config, runtimeVars);
    const client = await ensureClient(connectionId, resolvedConfig);

    const doc = (document && typeof document === 'object') ? document : {};
    const dbName = doc.database
      ? doc.database
      : resolvedConfig.database;
    if (!dbName) throw new Error('MongoDB operation requires a database name');
    const db = client.db(dbName);
    const collectionName = doc.collection;
    if (!collectionName && operation !== 'aggregate') {
      throw new Error('MongoDB operation requires collection');
    }

    if (operation === 'aggregate') {
      const col = db.collection(collectionName || '_aggregate');
      const cursor = col.aggregate(doc.pipeline || [], options);
      return { result: await cursor.toArray() };
    }

    const collection = db.collection(collectionName);

    switch (operation) {
      case 'findOne':
        return { result: await collection.findOne(document.query || {}, options) };
      case 'find': {
        const cursor = collection.find(document.query || {}, options);
        if (options.sort) cursor.sort(options.sort);
        if (options.skip) cursor.skip(options.skip);
        if (options.limit) cursor.limit(options.limit);
        return { result: await cursor.toArray() };
      }
      case 'insertOne':
        return { result: await collection.insertOne(document.document || document.data || {}, options) };
      case 'insertMany':
        return { result: await collection.insertMany(document.documents || document.data || [], options) };
      case 'updateOne':
        return { result: await collection.updateOne(document.query || {}, document.update || {}, options) };
      case 'updateMany':
        return { result: await collection.updateMany(document.query || {}, document.update || {}, options) };
      case 'deleteOne':
        return { result: await collection.deleteOne(document.query || {}, options) };
      case 'deleteMany':
        return { result: await collection.deleteMany(document.query || {}, options) };
      case 'countDocuments':
        return { result: await collection.countDocuments(document.query || {}, options) };
      case 'distinct':
        return { result: await collection.distinct(document.field || '_id', document.query || {}, options) };
      default:
        throw new Error(`Unsupported MongoDB operation: ${operation}`);
    }
  }

  async function closeAll() {
    const keys = [...mongoClients.keys()];
    for (const key of keys) {
      await closeClient(key);
    }
  }

  return { mongoQuery, closeAll };
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
    caCertPath: null,
    clientCertPath: null,
    clientKeyPath: null,
    clientKeyPassphrase: '',
    clientCertHost: '*',
    databasesPath: null,
    mongoUri: '',
    mongoDb: '',
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
    .option('--databases <file>', 'Database connections JSON file (array or { databases: [] })')
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
    .option('--data <file>', 'JSON data file (array of objects) for per-row iterations')
    .option('--retry <n>', 'Max retries per request on failure (0–10)', '0')
    .option('--retry-delay <ms>', 'Base delay between retries in ms', '1000')
    .option('--retry-backoff <fixed|exponential>', 'Backoff strategy (fixed or exponential)', 'fixed')
    .option('--retry-on <failures|errors|both>', 'What triggers a retry', 'both')
    .option('--mongo-uri <uri>', 'Override MongoDB URI for mongodb requests')
    .option('--mongo-db <db>', 'Override MongoDB database for mongodb requests')
    .option('--ssl-verification', 'Enable TLS certificate verification')
    .option('--ca-cert <file>', 'PEM CA certificate(s) to add to the trust store')
    .option('--client-cert <file>', 'PEM client certificate for mTLS')
    .option('--client-key <file>', 'PEM private key for --client-cert')
    .option('--client-key-passphrase <pass>', 'Passphrase for an encrypted --client-key')
    .option('--client-cert-host <pattern>', 'Hostname / *.wildcard scope for the client cert (default: * = all hosts)')
    .option('--no-follow-redirects', 'Disable automatic redirect following')
    .option('--no-color', 'Disable ANSI colors in terminal output')
    .action((collectionPath, opts) => {
      parsed.command = 'run';
      parsed.collectionPath = collectionPath || opts.collection;
      parsed.usedLegacyCollectionFlag = !collectionPath && !!opts.collection;
      parsed.environmentPath = opts.environment;
      parsed.globalsPath = opts.globals;
      parsed.collectionVarsPath = opts.collectionVars;
      parsed.databasesPath = opts.databases || null;
      parsed.csvPath = opts.csv;
      parsed.dataPath = opts.data;
      parsed.iterations = opts.iterations;
      parsed.maxRetries = opts.retry;
      parsed.retryDelay = opts.retryDelay;
      parsed.retryBackoff = opts.retryBackoff;
      parsed.retryOn = opts.retryOn;
      parsed.mongoUri = opts.mongoUri || '';
      parsed.mongoDb = opts.mongoDb || '';
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
      parsed.caCertPath          = opts.caCert             || null;
      parsed.clientCertPath      = opts.clientCert         || null;
      parsed.clientKeyPath       = opts.clientKey          || null;
      parsed.clientKeyPassphrase = opts.clientKeyPassphrase || '';
      parsed.clientCertHost      = opts.clientCertHost     || '*';
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
  const isMongo = result.protocol === 'mongodb' || String(result.method || '').startsWith('MONGO:');
  rows.push({
    requestName: `${namePrefix}${result.name}`,
    statusCode: isMongo ? (result.mongoStatus || result.statusText || 'MONGO') : result.status,
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

    const statusCode = Number.isFinite(Number(row.statusCode))
      ? (Number(row.statusCode) >= 400 ? chalk.red(String(row.statusCode)) : chalk.green(String(row.statusCode)))
      : chalk.cyan(String(row.statusCode));

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
  let closeDbResources = async () => {};

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
    const databasesJson = args.databasesPath
      ? await readJsonFile(io, args.databasesPath, 'databases')
      : null;
    if (args.csvPath && args.dataPath) {
      throw new Error('Use either --csv or --data, not both');
    }
    const csvText = args.csvPath
      ? await readTextFile(io, args.csvPath, 'csv')
      : null;
    let jsonRows = null;
    if (args.dataPath) {
      const dataText = await readTextFile(io, args.dataPath, 'data');
      try {
        const parsed = JSON.parse(dataText);
        if (!Array.isArray(parsed)) throw new Error('must be an array of objects');
        jsonRows = parsed;
      } catch (e) {
        throw new Error(`Invalid JSON data file: ${e.message}`);
      }
    }

    const collection = normalizeCollection(collectionJson);
    const environment = normalizeEnvironment(environmentJson);
    const globals = normalizeVariableMap(globalsJson, 'globals');
    const collectionVariables = normalizeVariableMap(collectionVarsJson, 'collection variables');
    const databases = normalizeDatabases(databasesJson);

    const baseRuntimeVars = {
      ...environment.vars,
      ...collectionVariables,
      ...globals,
    };
    const sqlApi = createCliDbQueryFn(databases, baseRuntimeVars);
    const mongoApi = createCliMongoQueryFn(databases, baseRuntimeVars);
    closeDbResources = async () => {
      await sqlApi.closeAll();
      await mongoApi.closeAll();
    };

    const customCAsText = args.caCertPath
      ? await readTextFile(io, args.caCertPath, 'CA certificate')
      : '';

    if (!!args.clientCertPath !== !!args.clientKeyPath) {
      throw new Error('--client-cert and --client-key must be used together');
    }
    const clientCertText = args.clientCertPath
      ? await readTextFile(io, args.clientCertPath, 'client certificate')
      : '';
    const clientKeyText = args.clientKeyPath
      ? await readTextFile(io, args.clientKeyPath, 'client key')
      : '';

    if (customCAsText && !args.sslVerification) {
      io.stderr.write('Warning: --ca-cert has no effect unless --ssl-verification is also set.\n');
    }

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
      customCAs: customCAsText,
      clientCertificates: clientCertText ? [{
        host: args.clientCertHost || '*',
        cert: clientCertText,
        key: clientKeyText,
        passphrase: args.clientKeyPassphrase || undefined,
        enabled: true,
      }] : [],
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
      maxRetries: Math.max(0, Math.min(10, parseInt(args.maxRetries, 10) || 0)),
      retryDelay: (() => { const d = parseInt(args.retryDelay, 10); return Math.max(0, Number.isNaN(d) ? 1000 : d); })(),
      retryBackoff: args.retryBackoff === 'exponential' ? 'exponential' : 'fixed',
      retryOn: ['failures', 'errors', 'both'].includes(args.retryOn) ? args.retryOn : 'both',
      allCollectionItems: collection.item,
      mockBase: null,
      mongoConnections: {},
      databases,
      dbQueryFn: sqlApi.query,
      dbMongoQueryFn: mongoApi.mongoQuery,
    };

    if (args.mongoUri) {
      payload.mongoConnections.__cli = {
        uri: args.mongoUri,
        database: args.mongoDb || '',
      };
      const applyMongoOverrides = (items) => {
        for (const item of (items || [])) {
          if (item.item) {
            applyMongoOverrides(item.item);
            continue;
          }
          if (item.request?.requestType === 'mongodb' || item.request?.mongodb) {
            item.request = item.request || {};
            item.request.requestType = 'mongodb';
            item.request.mongodb = item.request.mongodb || {};
            item.request.mongodb.connection = { mode: 'named', connectionId: '__cli' };
            if (args.mongoDb) item.request.mongodb.database = args.mongoDb;
          }
        }
      };
      applyMongoOverrides(payload.collection.item);
      applyMongoOverrides(payload.allCollectionItems);
    }

    const startedAt = new Date().toISOString();
    const prepared = prepareCollectionRun(payload, { csvText, jsonRows });
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
        databasesPath: args.databasesPath ? path.relative(io.cwd, resolvePath(io, args.databasesPath)) : null,
        csvPath: args.csvPath ? path.relative(io.cwd, resolvePath(io, args.csvPath)) : null,
        dataPath: args.dataPath ? path.relative(io.cwd, resolvePath(io, args.dataPath)) : null,
        maxRetries: payload.maxRetries,
        retryDelay: payload.retryDelay,
        retryBackoff: payload.retryBackoff,
        retryOn: payload.retryOn,
        iterations: payload.iterations,
        delay: payload.delay,
        executeChildRequests: payload.executeChildRequests,
        conditionalExecution: payload.conditionalExecution,
        timeout,
        followRedirects: args.followRedirects !== false,
        sslVerification: args.sslVerification === true,
        caCertPath:     args.caCertPath     ? path.relative(io.cwd, resolvePath(io, args.caCertPath))     : null,
        clientCertPath: args.clientCertPath ? path.relative(io.cwd, resolvePath(io, args.clientCertPath)) : null,
        clientKeyPath:  args.clientKeyPath  ? path.relative(io.cwd, resolvePath(io, args.clientKeyPath))  : null,
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
  } finally {
    await closeDbResources();
  }
}

module.exports = {
  runCli,
  parseArgs,
  usage,
  buildSummaryTable,
};
