export interface VariableSuggestion {
  name: string;
  value?: string;
}

export interface VariableTokenMatch {
  openIndex: number;
  query: string;
}

export function buildVariableSuggestions(vars: Record<string, string>): VariableSuggestion[] {
  return Object.keys(vars)
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .map(name => ({ name, value: vars[name] }));
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