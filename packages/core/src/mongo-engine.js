/**
 * MongoDB Query Execution Engine
 * Handles connection management, collection discovery, and query execution
 */

const { MongoClient } = require('mongodb');

class MongoEngine {
  constructor() {
    this.clients = new Map(); // connectionId -> MongoClient
  }

  /**
   * Test a MongoDB connection
   * @param {string} connectionUri - MongoDB connection string
   * @returns {Promise<boolean>} true if connection succeeds
   */
  async testConnection(connectionUri) {
    const client = new MongoClient(connectionUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });

    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      await client.close();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get or create a cached MongoDB client
   * @param {string} connectionUri - MongoDB connection string
   * @returns {Promise<MongoClient>}
   */
  async getClient(connectionUri) {
    if (this.clients.has(connectionUri)) {
      return this.clients.get(connectionUri);
    }

    const client = new MongoClient(connectionUri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      maxPoolSize: 5,
    });

    try {
      await client.connect();
      this.clients.set(connectionUri, client);
      return client;
    } catch (error) {
      throw new Error(`Failed to connect to MongoDB: ${error.message}`);
    }
  }

  /**
   * List all collections in a database
   * @param {string} connectionUri - MongoDB connection string
   * @param {string} database - Database name
   * @returns {Promise<Array>} Array of collection names with metadata
   */
  async listCollections(connectionUri, database) {
    const client = await this.getClient(connectionUri);

    try {
      const db = client.db(database);
      const collections = await db.listCollections().toArray();

      // Fetch additional metadata for each collection
      const result = await Promise.all(
        collections.map(async (col) => {
          try {
            const stats = await db.collection(col.name).stats();
            return {
              name: col.name,
              count: stats.count || 0,
              avgSize: stats.avgObjSize || 0,
              totalSize: stats.size || 0,
            };
          } catch {
            // If stats fail, return basic info
            return {
              name: col.name,
              count: 0,
            };
          }
        })
      );

      return result.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(`Failed to list collections: ${error.message}`);
    }
  }

  /**
   * Execute a MongoDB query (find operation)
   * @param {string} connectionUri - MongoDB connection string
   * @param {string} database - Database name
   * @param {string} collection - Collection name
   * @param {string} query - MongoDB filter as JSON string
   * @param {number} limit - Result limit (default 100)
   * @returns {Promise<Object>} Query result
   */
  async executeQuery(connectionUri, database, collection, query, limit = 100) {
    const client = await this.getClient(connectionUri);
    const startTime = Date.now();

    try {
      // Parse the query filter
      let filter = {};
      if (query && query.trim()) {
        try {
          filter = JSON.parse(query);
        } catch (e) {
          return {
            success: false,
            error: `Invalid query JSON: ${e.message}`,
            executionTime: Date.now() - startTime,
          };
        }
      }

      const db = client.db(database);
      const coll = db.collection(collection);

      // Execute the find query with limit
      const results = await coll
        .find(filter)
        .limit(Math.min(limit, 1000))
        .toArray();

      // Get the total count without limit for reference
      const count = await coll.countDocuments(filter);

      return {
        success: true,
        data: results,
        documentCount: results.length,
        totalMatching: count,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute an aggregation pipeline
   * @param {string} connectionUri - MongoDB connection string
   * @param {string} database - Database name
   * @param {string} collection - Collection name
   * @param {string} pipelineJson - MongoDB aggregation pipeline as JSON string
   * @returns {Promise<Object>} Query result
   */
  async executeAggregation(connectionUri, database, collection, pipelineJson) {
    const client = await this.getClient(connectionUri);
    const startTime = Date.now();

    try {
      let pipeline = [];
      if (pipelineJson && pipelineJson.trim()) {
        try {
          const parsed = JSON.parse(pipelineJson);
          pipeline = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
          return {
            success: false,
            error: `Invalid pipeline JSON: ${e.message}`,
            executionTime: Date.now() - startTime,
          };
        }
      }

      const db = client.db(database);
      const coll = db.collection(collection);

      // Execute aggregation
      const results = await coll.aggregate(pipeline).limit(1000).toArray();

      return {
        success: true,
        data: results,
        documentCount: results.length,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * List all databases on a MongoDB server
   * @param {string} connectionUri - MongoDB connection string
   * @returns {Promise<Array>} Array of database names
   */
  async listDatabases(connectionUri) {
    const client = await this.getClient(connectionUri);

    try {
      const result = await client.db('admin').admin().listDatabases();
      return result.databases
        .map(db => db.name)
        .filter(name => !['admin', 'config', 'local'].includes(name))
        .sort();
    } catch (error) {
      throw new Error(`Failed to list databases: ${error.message}`);
    }
  }

  /**
   * Close a cached client connection
   * @param {string} connectionUri - MongoDB connection string
   */
  async closeConnection(connectionUri) {
    const client = this.clients.get(connectionUri);
    if (client) {
      await client.close();
      this.clients.delete(connectionUri);
    }
  }

  /**
   * Close all cached connections
   */
  async closeAll() {
    for (const [, client] of this.clients) {
      try {
        await client.close();
      } catch {
        // Ignore errors on close
      }
    }
    this.clients.clear();
  }
}

// Export singleton instance
module.exports = new MongoEngine();
