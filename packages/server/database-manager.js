'use strict';

/**
 * Unified database connection pool manager.
 * Supports MySQL, PostgreSQL, and MongoDB.
 * Pools are keyed by connection ID and lazily created on first use.
 */

// Pool registry: poolId → { client, type, config }
const pools = new Map();

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
 * Execute a SQL query on a named pool.
 * @param {string} poolId
 * @param {string} sql
 * @param {Array} params  Parameterized values
 * @returns {Promise<{rows: object[], columns: string[], rowCount: number}>}
 */
async function executeQuery(poolId, sql, params = []) {
  const entry = pools.get(poolId);
  if (!entry) throw new Error(`No pool found for connection "${poolId}"`);
  if (entry.type !== 'mysql' && entry.type !== 'postgres') {
    throw new Error(`executeQuery is for SQL databases (mysql/postgres). Use mongoQuery for MongoDB.`);
  }

  if (entry.type === 'mysql') {
    const [rows] = await entry.client.query({ sql, timeout: entry.config.queryTimeout ?? 30000 }, params);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, columns, rowCount: rows.length };

  } else {
    // postgres
    const result = await entry.client.query(sql, params);
    const columns = result.fields ? result.fields.map(f => f.name) : [];
    return { rows: result.rows, columns, rowCount: result.rowCount ?? result.rows.length };
  }
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
  hasPool,
  listPools,
};
