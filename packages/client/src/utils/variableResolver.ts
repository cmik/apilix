import { resolveVariables as resolveVariablesCore } from '@apilix/core/variable-resolver';
import type { CollectionVariable } from '../types';

/**
 * Resolve {{variable}} placeholders in a string using the given variable map.
 * Priority order (highest to lowest): dataRow > environment > collectionVars > globals > collection definition vars
 *
 * Delegates to the canonical implementation in @apilix/core.
 */
export function resolveVariables(
  str: string,
  vars: Record<string, string>
): string {
  return resolveVariablesCore(str, vars) as string;
}

export function buildCollectionDefinitionVarMap(
  collectionVariables: CollectionVariable[] = [],
): Record<string, string> {
  return collectionVariables.reduce<Record<string, string>>((map, variable) => {
    if (variable.key && !variable.disabled) {
      map[variable.key] = variable.value ?? '';
    }
    return map;
  }, {});
}

export function buildVarMap(
  environment: Record<string, string>,
  collectionVars: Record<string, string>,
  globals: Record<string, string>,
  dataRow: Record<string, string> = {},
  collectionDefinitionVars: Record<string, string> = {},
): Record<string, string> {
  return { ...collectionDefinitionVars, ...globals, ...collectionVars, ...environment, ...dataRow };
}

export function getUrlDisplay(
  url: { raw?: string } | string | undefined,
  vars: Record<string, string>
): string {
  const raw = typeof url === 'string' ? url : url?.raw ?? '';
  return resolveVariables(raw, vars);
}

// ─── Used Variable Extraction ─────────────────────────────────────────────────

export type MongoUsedVarScope =
  | 'ENV'
  | 'COLL'
  | 'GLOBAL'
  | 'COLLECTION_DEF'
  | 'DYNAMIC'
  | 'UNRESOLVED';

export interface MongoUsedVariable {
  name: string;
  resolvedValue: string;
  scope: MongoUsedVarScope;
  /** False for DYNAMIC and COLLECTION_DEF tokens; true for all others. */
  isEditable: boolean;
}

/**
 * Scan `text` for all `{{varName}}` tokens, classify each by its winning scope,
 * and return a deduplicated list ordered by first appearance.
 *
 * Dynamic tokens (e.g. `$guid`) are included as non-editable DYNAMIC entries.
 * Collection-definition vars are included as non-editable COLLECTION_DEF entries
 * (edit them via Collection Settings).
 */
export function extractUsedVariables(
  text: string,
  envVars: Record<string, string>,
  collVars: Record<string, string>,
  globals: Record<string, string>,
  collectionDefinitionVars: Record<string, string> = {},
): MongoUsedVariable[] {
  if (typeof text !== 'string') return [];
  const seen = new Set<string>();
  const result: MongoUsedVariable[] = [];
  const regex = /\{\{([^}]+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    if (name.startsWith('$')) {
      result.push({ name, resolvedValue: '', scope: 'DYNAMIC', isEditable: false });
      continue;
    }

    const own = Object.prototype.hasOwnProperty;
    if (own.call(envVars, name)) {
      result.push({ name, resolvedValue: envVars[name], scope: 'ENV', isEditable: true });
    } else if (own.call(collVars, name)) {
      result.push({ name, resolvedValue: collVars[name], scope: 'COLL', isEditable: true });
    } else if (own.call(globals, name)) {
      result.push({ name, resolvedValue: globals[name], scope: 'GLOBAL', isEditable: true });
    } else if (own.call(collectionDefinitionVars, name)) {
      result.push({ name, resolvedValue: collectionDefinitionVars[name], scope: 'COLLECTION_DEF', isEditable: false });
    } else {
      result.push({ name, resolvedValue: '', scope: 'UNRESOLVED', isEditable: true });
    }
  }
  return result;
}
