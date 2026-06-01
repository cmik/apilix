import type { DatabaseConnection } from '../types';

export const DATABASE_CONNECTIONS_EXPORT_VERSION = '1' as const;

export interface DatabaseConnectionsExportPackage {
  apilixDatabaseConnectionsExport: typeof DATABASE_CONNECTIONS_EXPORT_VERSION;
  exportedAt: string;
  connections: DatabaseConnection[];
}

const SUPPORTED_TYPES = new Set([
  'mysql',
  'postgres',
  'mongodb',
  'sqlite',
  'redis',
  'cassandra',
  'dynamodb',
  'oracle',
  'mssql',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLikelyDatabaseConnection(value: unknown): value is DatabaseConnection {
  if (!isObject(value)) return false;
  if (typeof value.type !== 'string' || !SUPPORTED_TYPES.has(value.type)) return false;
  if (typeof value.name !== 'string') return false;
  return true;
}

function makeUniqueName(baseName: string, existingNames: Set<string>): string {
  let name = baseName;
  if (!existingNames.has(name)) {
    existingNames.add(name);
    return name;
  }
  let n = 2;
  while (existingNames.has(`${baseName} (${n})`)) {
    n += 1;
  }
  name = `${baseName} (${n})`;
  existingNames.add(name);
  return name;
}

export function makeDuplicateConnection(
  source: DatabaseConnection,
  existingNames: Iterable<string>,
  generateId: () => string
): DatabaseConnection {
  const nameSet = new Set(existingNames);
  const copyBase = `${source.name} Copy`;
  const duplicatedName = makeUniqueName(copyBase, nameSet);
  return {
    ...source,
    _id: generateId(),
    name: duplicatedName,
    createdAt: new Date().toISOString(),
    lastTestedAt: undefined,
    testStatus: undefined,
    testError: undefined,
  };
}

export function stripSecretFieldsFromConnection(
  connection: DatabaseConnection
): DatabaseConnection {
  const sanitized = { ...connection };
  const conn = sanitized as any;
  // Strip secret fields that should not be exported
  delete conn.password;
  delete conn.token;
  delete conn.secret;
  delete conn.accessKey;
  delete conn.secretKey;
  delete conn.apiKey;
  return sanitized;
}

export function buildDatabaseConnectionsExportPackage(
  connections: DatabaseConnection[],
  stripSecrets: boolean = true
): DatabaseConnectionsExportPackage {
  return {
    apilixDatabaseConnectionsExport: DATABASE_CONNECTIONS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    connections: stripSecrets ? connections.map(stripSecretFieldsFromConnection) : connections,
  };
}

export function parseDatabaseConnectionsImportText(text: string): DatabaseConnection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file.');
  }

  if (Array.isArray(parsed)) {
    return parsed.filter(isLikelyDatabaseConnection);
  }

  if (isLikelyDatabaseConnection(parsed)) {
    return [parsed];
  }

  if (isObject(parsed) && parsed.apilixDatabaseConnectionsExport === DATABASE_CONNECTIONS_EXPORT_VERSION) {
    const maybeConnections = parsed.connections;
    if (!Array.isArray(maybeConnections)) {
      throw new Error('Invalid database export: "connections" must be an array.');
    }
    return maybeConnections.filter(isLikelyDatabaseConnection);
  }

  throw new Error('Unsupported file format.');
}

export function normalizeImportedConnections(
  imported: DatabaseConnection[],
  existingConnections: DatabaseConnection[],
  generateId: () => string
): DatabaseConnection[] {
  const usedIds = new Set(existingConnections.map(c => c._id));
  const usedNames = new Set(existingConnections.map(c => c.name));

  return imported.map(conn => {
    let nextId = conn._id;
    if (!nextId || usedIds.has(nextId)) {
      do {
        nextId = generateId();
      } while (usedIds.has(nextId));
    }
    usedIds.add(nextId);

    const safeName = conn.name.trim() || 'Imported Connection';
    const uniqueName = makeUniqueName(safeName, usedNames);

    return {
      ...conn,
      _id: nextId,
      name: uniqueName,
      ssl: conn.ssl ?? false,
      createdAt: conn.createdAt || new Date().toISOString(),
      lastTestedAt: undefined,
      testStatus: undefined,
      testError: undefined,
    };
  });
}
