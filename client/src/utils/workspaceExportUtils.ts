import type { WorkspaceData, WorkspaceExportPackage, WorkspaceExportVersion } from '../types';

const CURRENT_VERSION: WorkspaceExportVersion = '1';

// ─── Build ────────────────────────────────────────────────────────────────────

/**
 * Serialise workspace data into a portable export package.
 * The returned object can be passed directly to `downloadJsonFile`.
 */
export function buildWorkspaceExportPackage(
  workspaceName: string,
  workspaceId: string,
  data: WorkspaceData,
): WorkspaceExportPackage {
  return {
    apilixWorkspaceExport: CURRENT_VERSION,
    exportedAt: new Date().toISOString(),
    workspaceName,
    workspaceId,
    data,
  };
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Returns true when `raw` looks like a `WorkspaceExportPackage`.
 */
export function isWorkspaceExportPackage(raw: unknown): raw is WorkspaceExportPackage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return (
    obj.apilixWorkspaceExport === CURRENT_VERSION &&
    typeof obj.workspaceName === 'string' &&
    typeof obj.workspaceId === 'string' &&
    !!obj.data &&
    typeof obj.data === 'object' &&
    !Array.isArray(obj.data)
  );
}

// ─── Parse / validate ─────────────────────────────────────────────────────────

/**
 * Parse and lightly validate a raw JSON value as a `WorkspaceExportPackage`.
 * Throws with a user-readable message if the value is not a valid package.
 * Missing optional `WorkspaceData` fields are backfilled with safe defaults
 * for supported workspace export packages.
 */
export function parseWorkspaceExportPackage(raw: unknown): WorkspaceExportPackage {
  if (!isWorkspaceExportPackage(raw)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj.apilixSyncExport !== undefined) {
        throw new Error('This file is a sync configuration export, not a workspace data export. Use "Import sync config" instead.');
      }
    }
    throw new Error('Not a valid Apilix workspace export file. Make sure you selected a file exported from "Export workspace data".');
  }

  // Backfill any fields added in future WorkspaceData versions
  const d = raw.data as unknown as Record<string, unknown>;
  const data: WorkspaceData = {
    collections: Array.isArray(d.collections) ? d.collections as WorkspaceData['collections'] : [],
    environments: Array.isArray(d.environments) ? d.environments as WorkspaceData['environments'] : [],
    activeEnvironmentId: typeof d.activeEnvironmentId === 'string' ? d.activeEnvironmentId : null,
    collectionVariables: (d.collectionVariables && typeof d.collectionVariables === 'object' && !Array.isArray(d.collectionVariables))
      ? d.collectionVariables as WorkspaceData['collectionVariables']
      : {},
    globalVariables: (d.globalVariables && typeof d.globalVariables === 'object' && !Array.isArray(d.globalVariables))
      ? d.globalVariables as WorkspaceData['globalVariables']
      : {},
    cookieJar: (d.cookieJar && typeof d.cookieJar === 'object' && !Array.isArray(d.cookieJar))
      ? d.cookieJar as WorkspaceData['cookieJar']
      : {},
    mockCollections: Array.isArray(d.mockCollections) ? d.mockCollections as WorkspaceData['mockCollections'] : [],
    mockRoutes: Array.isArray(d.mockRoutes) ? d.mockRoutes as WorkspaceData['mockRoutes'] : [],
    mockPort: typeof d.mockPort === 'number' ? d.mockPort : 3002,
  };

  return { ...raw, data };
}
