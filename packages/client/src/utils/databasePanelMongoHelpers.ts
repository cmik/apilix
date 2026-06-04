import type { DatabaseConnection, MongoConnectionAuthSettings, MongoDBConnectionConfig } from '../types';
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
    database: resolveVariables(mongoConn.database || '', runtimeVars),
    auth: mongoConn.auth
      ? {
          ...mongoConn.auth,
          mode: (resolveVariables(mongoConn.auth.mode || '', runtimeVars) || undefined) as MongoConnectionAuthSettings['mode'],
          username: resolveVariables(mongoConn.auth.username || '', runtimeVars) || undefined,
          password: resolveVariables(mongoConn.auth.password || '', runtimeVars) || undefined,
          authSource: resolveVariables(mongoConn.auth.authSource || '', runtimeVars) || undefined,
          oidcAccessToken: resolveVariables(mongoConn.auth.oidcAccessToken || '', runtimeVars) || undefined,
        }
      : undefined,
    connectionUri: resolveVariables(mongoConn.connectionUri || '', runtimeVars),
  };
}