import type { CollectionVariable } from '../types';

/**
 * Resolve {{variable}} placeholders in a string using the given variable map.
 * Priority order (highest to lowest): dataRow > environment > collectionVars > globals > collection definition vars
 */
export function resolveVariables(
  str: string,
  vars: Record<string, string>
): string {
  if (!str) return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
    const trimmed = key.trim();
    return vars[trimmed] !== undefined ? vars[trimmed] : `{{${trimmed}}}`;
  });
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
