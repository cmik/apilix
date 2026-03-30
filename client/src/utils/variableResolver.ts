/**
 * Resolve {{variable}} placeholders in a string using the given variable map.
 * Priority order (highest to lowest): dataRow > environment > collectionVars > globals
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

export function buildVarMap(
  environment: Record<string, string>,
  collectionVars: Record<string, string>,
  globals: Record<string, string>,
  dataRow: Record<string, string> = {}
): Record<string, string> {
  return { ...globals, ...collectionVars, ...environment, ...dataRow };
}

export function getUrlDisplay(
  url: { raw?: string } | string | undefined,
  vars: Record<string, string>
): string {
  const raw = typeof url === 'string' ? url : url?.raw ?? '';
  return resolveVariables(raw, vars);
}
