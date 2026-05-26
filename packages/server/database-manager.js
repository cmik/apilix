'use strict';

/**
 * Unified database connection pool manager.
 * Supports SQL, NoSQL, and key-value backends.
 * Pools are keyed by connection ID and lazily created on first use.
 */

// Pool registry: poolId → { client, type, config }
const pools = new Map();

function requireDriver(packageName, installHint) {
  try {
    return require(packageName);
  } catch {
    throw new Error(`Driver "${packageName}" is not installed. ${installHint}`);
  }
}

function normalizeRowsFromResult(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return { value: row };
    if (typeof row.toJSON === 'function') return row.toJSON();
    return { ...row };
  });
}

function normalizeColumns(rows) {
  if (!rows.length) return [];
  return Object.keys(rows[0]);
}

function buildOracleConnectString(config) {
  if (typeof config.connectString === 'string' && config.connectString.trim()) {
    return config.connectString;
  }
  const host = config.host;
  const port = config.port ?? 1521;
  const service = config.serviceName || config.database;
  if (service) {
    return `${host}:${port}/${service}`;
  }
  if (config.sid) {
    return `${host}:${port}:${config.sid}`;
  }
  return `${host}:${port}`;
}

// ─── Pool Management ──────────────────────────────────────────────────────────

/**
 * Create or replace a connection pool for the given config.
 * @param {string} poolId  Unique identifier for this pool
 * @param {object} config  DatabaseConnection config object
 */
async function createPool(poolId, config) {
  // Close existing pool if it exists
  if (pools.has(poolId)) {
    await closePool(poolId);
  }

  const timeout = config.connectionTimeout ?? 10000;
  const maxConns = config.maxConnections ?? 5;

  if (config.type === 'mysql') {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      host: config.host,
      port: config.port ?? 3306,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.ssl ? { rejectUnauthorized: config.sslRejectUnauthorized !== false } : undefined,
      connectTimeout: timeout,
      connectionLimit: maxConns,
      waitForConnections: true,
      enableKeepAlive: true,
    });
    pools.set(poolId, { client: pool, type: 'mysql', config });

  } else if (config.type === 'postgres') {
    const { Pool } = require('pg');
    const pool = new Pool({
      host: config.host,
      port: config.port ?? 5432,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.ssl
        ? {
            rejectUnauthorized: config.sslRejectUnauthorized !== false,
            ca: config.sslCert || undefined,
          }
        : false,
      connectionTimeoutMillis: timeout,
      max: maxConns,
    });
    // Forward errors to prevent unhandled error events from crashing
    pool.on('error', (err) => {
      console.error(`[db-manager] Postgres pool error for ${poolId}:`, err.message);
    });
    pools.set(poolId, { client: pool, type: 'postgres', config });

  } else if (config.type === 'mongodb') {
    const { MongoClient } = require('mongodb');
    const uri = config.connectionUri;
    const tlsCertificateKeyFile = config.sslKeyPath || config.sslCertPath || undefined;
    const client = new MongoClient(uri, {
      maxPoolSize: maxConns,
      connectTimeoutMS: timeout,
      serverSelectionTimeoutMS: timeout,
      authMechanism: config.authMechanism || undefined,
      tls: config.ssl,
      tlsAllowInvalidCertificates: config.sslRejectUnauthorized === false,
      tlsCAFile: config.sslCAPath || undefined,
      tlsCertificateKeyFile,
    });
    await client.connect();
    pools.set(poolId, { client, type: 'mongodb', config });

  } else if (config.type === 'sqlite') {
    const Database = requireDriver('better-sqlite3', 'Run: npm install better-sqlite3 in packages/server');
    const db = new Database(config.filePath, { readonly: config.readonly === true });
    db.pragma('foreign_keys = ON');
    pools.set(poolId, { client: db, type: 'sqlite', config });

  } else if (config.type === 'redis') {
    const Redis = requireDriver('ioredis', 'Run: npm install ioredis in packages/server');
    const redisOptions = config.connectionUri
      ? config.connectionUri
      : {
          host: config.host,
          port: config.port ?? 6379,
          username: config.username || undefined,
          password: config.password || undefined,
          db: config.db ?? 0,
          tls: config.ssl ? { rejectUnauthorized: config.sslRejectUnauthorized !== false } : undefined,
          connectTimeout: timeout,
        };
    const client = new Redis(redisOptions);
    pools.set(poolId, { client, type: 'redis', config });

  } else if (config.type === 'cassandra') {
    const cassandra = requireDriver('cassandra-driver', 'Run: npm install cassandra-driver in packages/server');
    const client = new cassandra.Client({
      contactPoints: config.contactPoints,
      localDataCenter: config.localDataCenter,
      keyspace: config.keyspace || undefined,
      protocolOptions: { port: config.port ?? 9042 },
      credentials: config.username
        ? new cassandra.auth.PlainTextAuthProvider(config.username, config.password || '')
        : undefined,
      pooling: {
        coreConnectionsPerHost: {
          0: config.maxConnections ?? 2,
        },
      },
      socketOptions: {
        connectTimeout: timeout,
      },
    });
    await client.connect();
    pools.set(poolId, { client, type: 'cassandra', config });

  } else if (config.type === 'dynamodb') {
    const { DynamoDBClient } = requireDriver('@aws-sdk/client-dynamodb', 'Run: npm install @aws-sdk/client-dynamodb in packages/server');
    const client = new DynamoDBClient({
      region: config.region,
      endpoint: config.endpoint || undefined,
      credentials: config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            sessionToken: config.sessionToken || undefined,
          }
        : undefined,
    });
    pools.set(poolId, { client, type: 'dynamodb', config });

  } else if (config.type === 'oracle') {
    const oracledb = requireDriver('oracledb', 'Run: npm install oracledb in packages/server (Oracle Instant Client may be required)');
    const pool = await oracledb.createPool({
      user: config.username,
      password: config.password,
      connectString: buildOracleConnectString(config),
      poolMax: config.maxConnections ?? 5,
      poolMin: 0,
      poolTimeout: Math.ceil(timeout / 1000),
    });
    pools.set(poolId, { client: pool, type: 'oracle', config });

  } else if (config.type === 'mssql') {
    const mssql = requireDriver('mssql', 'Run: npm install mssql in packages/server');
    const pool = new mssql.ConnectionPool({
      server: config.host,
      port: config.port ?? 1433,
      user: config.username,
      password: config.password,
      database: config.database,
      options: {
        encrypt: config.encrypt !== false,
        trustServerCertificate: config.trustServerCertificate === true,
        instanceName: config.instanceName || undefined,
      },
      pool: {
        max: config.maxConnections ?? 5,
        min: 0,
        idleTimeoutMillis: timeout,
      },
    });
    const client = await pool.connect();
    pools.set(poolId, { client, type: 'mssql', config, mssql });

  } else {
    throw new Error(`Unsupported database type: ${config.type}`);
  }
}

/**
 * Close and remove a pool.
 * @param {string} poolId
 */
async function closePool(poolId) {
  const entry = pools.get(poolId);
  if (!entry) return;
  try {
    if (entry.type === 'mongodb') {
      await entry.client.close();
    } else if (entry.type === 'postgres') {
      await entry.client.end();
    } else if (entry.type === 'mysql') {
      await entry.client.end();
    } else if (entry.type === 'sqlite') {
      entry.client.close();
    } else if (entry.type === 'redis') {
      await entry.client.quit();
    } else if (entry.type === 'cassandra') {
      await entry.client.shutdown();
    } else if (entry.type === 'dynamodb') {
      entry.client.destroy();
    } else if (entry.type === 'oracle') {
      await entry.client.close(0);
    } else if (entry.type === 'mssql') {
      await entry.client.close();
    }
  } catch (err) {
    // Best effort cleanup
    console.error(`[db-manager] Error closing pool ${poolId}:`, err.message);
  } finally {
    pools.delete(poolId);
  }
}

/**
 * Close all pools (e.g., on server shutdown).
 */
async function closeAllPools() {
  const ids = [...pools.keys()];
  await Promise.all(ids.map(id => closePool(id)));
}

// ─── Connection Testing ───────────────────────────────────────────────────────

/**
 * Test a database connection without storing the pool.
 * @param {object} config  DatabaseConnection config
 * @returns {Promise<{ok: boolean, error?: string, latencyMs?: number}>}
 */
async function testConnection(config) {
  const tempId = `__test__${Date.now()}`;
  const start = Date.now();
  try {
    await createPool(tempId, config);
    const entry = pools.get(tempId);

    if (entry.type === 'mysql') {
      const conn = await entry.client.getConnection();
      await conn.ping();
      conn.release();

    } else if (entry.type === 'postgres') {
      const client = await entry.client.connect();
      await client.query('SELECT 1');
      client.release();

    } else if (entry.type === 'mongodb') {
      await entry.client.db().admin().ping();
    } else if (entry.type === 'sqlite') {
      entry.client.prepare('SELECT 1 as ok').get();
    } else if (entry.type === 'redis') {
      await entry.client.ping();
    } else if (entry.type === 'cassandra') {
      await entry.client.execute('SELECT now() FROM system.local');
    } else if (entry.type === 'dynamodb') {
      const { ListTablesCommand } = requireDriver('@aws-sdk/client-dynamodb', 'Run: npm install @aws-sdk/client-dynamodb in packages/server');
      await entry.client.send(new ListTablesCommand({ Limit: 1 }));
    } else if (entry.type === 'oracle') {
      const conn = await entry.client.getConnection();
      await conn.execute('SELECT 1 FROM dual');
      await conn.close();
    } else if (entry.type === 'mssql') {
      await entry.client.request().query('SELECT 1 AS ok');
    }

    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };

  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await closePool(tempId);
  }
}

// ─── SQL Query Execution ──────────────────────────────────────────────────────

/**
 * Execute a SQL-style query on a named pool.
 * @param {string} poolId
 * @param {string} sql
 * @param {Array} params  Parameterized values
 * @returns {Promise<{rows: object[], columns: string[], rowCount: number}>}
 */
async function executeQuery(poolId, sql, params = []) {
  const entry = pools.get(poolId);
  if (!entry) throw new Error(`No pool found for connection "${poolId}"`);
  if (!['mysql', 'postgres', 'sqlite', 'cassandra', 'oracle', 'mssql'].includes(entry.type)) {
    throw new Error('executeQuery is for SQL-like databases. Use mongoQuery, executeRedisCommand, or executeDynamoOperation for non-SQL backends.');
  }

  if (entry.type === 'mysql') {
    const [rows] = await entry.client.query({ sql, timeout: entry.config.queryTimeout ?? 30000 }, params);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, columns, rowCount: rows.length };

  }

  if (entry.type === 'postgres') {
    const result = await entry.client.query(sql, params);
    const columns = result.fields ? result.fields.map(f => f.name) : [];
    return { rows: result.rows, columns, rowCount: result.rowCount ?? result.rows.length };
  }

  if (entry.type === 'sqlite') {
    const stmt = entry.client.prepare(sql);
    if (stmt.reader) {
      const rows = normalizeRowsFromResult(stmt.all(...params));
      return { rows, columns: normalizeColumns(rows), rowCount: rows.length };
    }
    const info = stmt.run(...params);
    return { rows: [], columns: [], rowCount: info.changes ?? 0 };
  }

  if (entry.type === 'cassandra') {
    const result = await entry.client.execute(sql, params, { prepare: true });
    const rows = normalizeRowsFromResult(result.rows || []);
    return { rows, columns: normalizeColumns(rows), rowCount: rows.length };
  }

  if (entry.type === 'oracle') {
    const conn = await entry.client.getConnection();
    try {
      const result = await conn.execute(sql, params || [], { outFormat: 4002 });
      const rows = normalizeRowsFromResult(result.rows || []);
      const columns = Array.isArray(result.metaData) ? result.metaData.map((m) => m.name) : normalizeColumns(rows);
      return { rows, columns, rowCount: rows.length };
    } finally {
      await conn.close();
    }
  }

  if (entry.type === 'mssql') {
    const request = entry.client.request();
    (params || []).forEach((v, i) => {
      request.input(`p${i}`, v);
    });
    const result = await request.query(sql);
    const rows = normalizeRowsFromResult(result.recordset || []);
    return { rows, columns: normalizeColumns(rows), rowCount: rows.length };
  }

  throw new Error(`Unsupported SQL-like database type: ${entry.type}`);
}

// ─── MongoDB Operations ───────────────────────────────────────────────────────

const ALLOWED_MONGO_OPS = new Set([
  'findOne', 'find', 'insertOne', 'insertMany',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'countDocuments', 'distinct', 'aggregate',
]);

/**
 * Execute a MongoDB operation on a named pool.
 * @param {string} poolId
 * @param {string} operation  e.g. 'findOne', 'find', 'insertOne', etc.
 * @param {object} document   { database?, collection, query?, update?, pipeline?, etc. }
 * @param {object} options    Additional driver options (sort, limit, etc.)
 * @returns {Promise<{result: any}>}
 */
async function mongoQuery(poolId, operation, document, options = {}) {
  const entry = pools.get(poolId);
  if (!entry) throw new Error(`No pool found for connection "${poolId}"`);
  if (entry.type !== 'mongodb') {
    throw new Error(`mongoQuery is for MongoDB connections. Use executeQuery for SQL.`);
  }

  if (!ALLOWED_MONGO_OPS.has(operation)) {
    throw new Error(`Unsupported MongoDB operation: "${operation}". Allowed: ${[...ALLOWED_MONGO_OPS].join(', ')}`);
  }

  const dbName = document.database || entry.config.defaultDatabase;
  if (!dbName) throw new Error('MongoDB operation requires a "database" field in the document object or a default database in the connection config.');

  const collectionName = document.collection;
  if (!collectionName && operation !== 'aggregate') {
    throw new Error('MongoDB operation requires a "collection" field.');
  }

  const db = entry.client.db(dbName);

  if (operation === 'aggregate') {
    const pipeline = document.pipeline || [];
    const col = db.collection(collectionName || '_aggregate');
    const cursor = col.aggregate(pipeline, options);
    const result = await cursor.toArray();
    return { result };
  }

  const col = db.collection(collectionName);

  switch (operation) {
    case 'findOne': {
      const result = await col.findOne(document.query || {}, options);
      return { result };
    }
    case 'find': {
      const cursor = col.find(document.query || {}, options);
      if (options.sort) cursor.sort(options.sort);
      if (options.skip) cursor.skip(options.skip);
      if (options.limit) cursor.limit(options.limit);
      const result = await cursor.toArray();
      return { result };
    }
    case 'insertOne': {
      const result = await col.insertOne(document.document || document.data || {}, options);
      return { result };
    }
    case 'insertMany': {
      const docs = document.documents || document.data || [];
      const result = await col.insertMany(docs, options);
      return { result };
    }
    case 'updateOne': {
      const result = await col.updateOne(document.query || {}, document.update || {}, options);
      return { result };
    }
    case 'updateMany': {
      const result = await col.updateMany(document.query || {}, document.update || {}, options);
      return { result };
    }
    case 'deleteOne': {
      const result = await col.deleteOne(document.query || {}, options);
      return { result };
    }
    case 'deleteMany': {
      const result = await col.deleteMany(document.query || {}, options);
      return { result };
    }
    case 'countDocuments': {
      const result = await col.countDocuments(document.query || {}, options);
      return { result };
    }
    case 'distinct': {
      const result = await col.distinct(document.field || '_id', document.query || {}, options);
      return { result };
    }
    default:
      throw new Error(`Unhandled MongoDB operation: ${operation}`);
  }
}

const ALLOWED_REDIS_COMMANDS = new Set([
  'GET', 'SET', 'DEL', 'EXISTS', 'EXPIRE', 'TTL',
  'HGET', 'HSET', 'HGETALL', 'HMGET', 'HMSET',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE',
  'SADD', 'SREM', 'SMEMBERS',
  'ZADD', 'ZRANGE', 'ZREM',
  'INCR', 'DECR', 'MGET', 'MSET', 'PING',
]);

async function executeRedisCommand(poolId, command, args = []) {
  const entry = pools.get(poolId);
  if (!entry) throw new Error(`No pool found for connection "${poolId}"`);
  if (entry.type !== 'redis') throw new Error('executeRedisCommand is only valid for redis connections.');

  const cmd = String(command || '').trim().toUpperCase();
  if (!ALLOWED_REDIS_COMMANDS.has(cmd)) {
    throw new Error(`Unsupported Redis command: "${cmd}"`);
  }
  if (!Array.isArray(args)) throw new Error('Redis args must be an array');

  const result = await entry.client.call(cmd, ...args);
  return { result };
}

const ALLOWED_DYNAMO_OPERATIONS = new Set([
  'GetItem',
  'PutItem',
  'UpdateItem',
  'DeleteItem',
  'Query',
  'Scan',
]);

async function executeDynamoOperation(poolId, operation, input = {}) {
  const entry = pools.get(poolId);
  if (!entry) throw new Error(`No pool found for connection "${poolId}"`);
  if (entry.type !== 'dynamodb') throw new Error('executeDynamoOperation is only valid for dynamodb connections.');

  const op = String(operation || '').trim();
  if (!ALLOWED_DYNAMO_OPERATIONS.has(op)) {
    throw new Error(`Unsupported DynamoDB operation: "${op}"`);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('DynamoDB input must be an object');
  }

  const sdk = requireDriver('@aws-sdk/client-dynamodb', 'Run: npm install @aws-sdk/client-dynamodb in packages/server');
  const commandMap = {
    GetItem: sdk.GetItemCommand,
    PutItem: sdk.PutItemCommand,
    UpdateItem: sdk.UpdateItemCommand,
    DeleteItem: sdk.DeleteItemCommand,
    Query: sdk.QueryCommand,
    Scan: sdk.ScanCommand,
  };

  const Cmd = commandMap[op];
  const result = await entry.client.send(new Cmd(input));
  return { result };
}

function getPoolType(poolId) {
  const entry = pools.get(poolId);
  return entry ? entry.type : null;
}

// ─── Pool Health / Status ─────────────────────────────────────────────────────

/**
 * Check if a named pool exists.
 * @param {string} poolId
 */
function hasPool(poolId) {
  return pools.has(poolId);
}

/**
 * List active pool IDs.
 */
function listPools() {
  return [...pools.keys()];
}

module.exports = {
  createPool,
  closePool,
  closeAllPools,
  testConnection,
  executeQuery,
  mongoQuery,
  executeRedisCommand,
  executeDynamoOperation,
  getPoolType,
  hasPool,
  listPools,
};
