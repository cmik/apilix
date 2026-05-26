import type { DatabaseConnection, MongoDBConnectionConfig } from '../types';
import { resolveVariables } from './variableResolver';

export function getMongoDatabaseFromUri(uri: string): string {
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    const trimmedPath = parsed.pathname.replace(/^\/+/, '').trim();
    if (!trimmedPath) return '';
    return decodeURIComponent(trimmedPath.split('/')[0] || '');
  } catch {
    return '';
  }
}

export function resolveMongoConnectionTemplates(conn: DatabaseConnection, runtimeVars: Record<string, string>): MongoDBConnectionConfig | null {
  if (conn.type !== 'mongodb') return null;
  const mongoConn = conn as MongoDBConnectionConfig;
  return {
    ...mongoConn,
    connectionUri: resolveVariables(mongoConn.connectionUri || '', runtimeVars),
  };
}