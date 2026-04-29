export interface VariableSuggestion {
  name: string;
  value?: string;
}

export interface VariableTokenMatch {
  openIndex: number;
  query: string;
}

/**
 * Dynamic (generated-at-send-time) variable tokens shown in autocomplete.
 * $randomFloat and $randomItem are intentionally excluded: their parameterised
 * syntax (e.g. {{$randomItem(a,b,c)}}) cannot be completed by the current
 * token-completion mechanism which only substitutes a bare name.
 */
export const DYNAMIC_VARIABLE_SUGGESTIONS: readonly VariableSuggestion[] = Object.freeze([
  { name: '$guid',         value: 'Random UUID v4' },
  { name: '$timestamp',    value: 'Unix timestamp (ms)' },
  { name: '$isoTimestamp', value: 'ISO 8601 date-time' },
  { name: '$randomInt',    value: 'Random integer 0–9999' },
]);

export function buildVariableSuggestions(vars: Record<string, string>): VariableSuggestion[] {
  return Object.keys(vars)
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .map(name => ({ name, value: vars[name] }));
}

/**
 * Builds the full suggestion list for request-building contexts:
 * dynamic tokens first, then user-defined variables sorted alphabetically.
 * User variables whose names collide with a dynamic token are excluded to
 * prevent duplicate entries in the dropdown.
 */
export function buildAllVariableSuggestions(vars: Record<string, string>): VariableSuggestion[] {
  const dynamicNames = new Set(DYNAMIC_VARIABLE_SUGGESTIONS.map(s => s.name));
  const userSuggestions = buildVariableSuggestions(vars).filter(s => !dynamicNames.has(s.name));
  return [...DYNAMIC_VARIABLE_SUGGESTIONS, ...userSuggestions];
}

export function findVariableToken(value: string, cursor: number): VariableTokenMatch | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, safeCursor);
  const openIndex = beforeCursor.lastIndexOf('{{');
  if (openIndex === -1) return null;

  const tokenText = beforeCursor.slice(openIndex + 2);
  if (tokenText.includes('}}')) return null;

  return {
    openIndex,
    query: tokenText.trim(),
  };
}

export function filterVariableSuggestions(
  suggestions: VariableSuggestion[],
  query: string,
): VariableSuggestion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return suggestions;
  return suggestions.filter(suggestion => suggestion.name.toLowerCase().startsWith(needle));
}

export function applyVariableSuggestion(
  value: string,
  cursor: number,
  suggestionName: string,
): { value: string; cursor: number } | null {
  const token = findVariableToken(value, cursor);
  if (!token) return null;

  const nextValue = value.slice(0, token.openIndex) + `{{${suggestionName}}}` + value.slice(cursor);
  return {
    value: nextValue,
    cursor: token.openIndex + suggestionName.length + 4,
  };
}

export function previewVariableValue(value?: string): string {
  if (value === undefined || value === '') return '';
  return value.length > 36 ? `${value.slice(0, 33)}...` : value;
}