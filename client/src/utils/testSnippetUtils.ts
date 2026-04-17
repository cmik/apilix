/**
 * Shared utilities for generating test script snippets from a JSON response
 * path. Used by both ResponseViewer (injection) and SaveToVarModal (preview).
 */

/**
 * Converts a path array like `['data', 0, 'token']` into an optional-chained
 * JavaScript accessor expression rooted at `apx.response.json()`.
 *
 * Examples:
 *   []              → "apx.response.json()"
 *   ['token']       → "apx.response.json()?.token"
 *   ['data', 0]     → "apx.response.json()?.data?.[0]"
 *   ['my-key']      → 'apx.response.json()?.["my-key"]'
 */
export function buildJsonAccessExpression(path: (string | number)[]): string {
  return path.reduce((acc: string, seg: string | number): string => {
    if (typeof seg === 'number') return `${acc}?.[${seg}]`;
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(seg)) return `${acc}?.${seg}`;
    return `${acc}?.[${JSON.stringify(seg)}]`;
  }, 'apx.response.json()');
}

/**
 * Builds a one-liner test script that saves the value at `path` into a
 * variable of the given `scope`.
 */
export function buildSaveToVarSnippet(
  varName: string,
  scope: 'environment' | 'globals' | 'collection',
  path: (string | number)[],
): string {
  const access = buildJsonAccessExpression(path);
  if (scope === 'environment') return `apx.environment.set('${varName}', ${access});`;
  if (scope === 'globals') return `apx.globals.set('${varName}', ${access});`;
  return `apx.collection.set('${varName}', ${access});`;
}

export interface TestValueSnippet {
  label: string;
  snippet: string;
}

export function buildTestValueSnippets(
  path: (string | number)[],
  value: unknown,
): TestValueSnippet[] {
  const access = buildJsonAccessExpression(path);
  const rawField = path.length > 0 ? String(path[path.length - 1]) : 'value';
  const nameExpr = (suffix: string): string => JSON.stringify(`${rawField} ${suffix}`);
  const snippets: TestValueSnippet[] = [];

  if (value === null) {
    snippets.push({
      label: 'Is null',
      snippet: `apx.test(${nameExpr('is null')}, () => {\n  apx.expect(${access}).to.be.null;\n});`,
    });
  } else if (typeof value === 'boolean') {
    snippets.push({
      label: `Is ${value}`,
      snippet: `apx.test(${nameExpr(`is ${value}`)}, () => {\n  apx.expect(${access}).to.be.${value};\n});`,
    });
    snippets.push({
      label: 'Is a boolean',
      snippet: `apx.test(${nameExpr('is a boolean')}, () => {\n  apx.expect(${access}).to.be.a('boolean');\n});`,
    });
  } else if (typeof value === 'number') {
    snippets.push({
      label: `Equals ${value}`,
      snippet: `apx.test(${nameExpr(`equals ${value}`)}, () => {\n  apx.expect(${access}).to.eql(${value});\n});`,
    });
    snippets.push({
      label: 'Is a number',
      snippet: `apx.test(${nameExpr('is a number')}, () => {\n  apx.expect(${access}).to.be.a('number');\n});`,
    });
    if (value > 0) {
      snippets.push({
        label: 'Is positive',
        snippet: `apx.test(${nameExpr('is positive')}, () => {\n  apx.expect(${access}).to.be.positive;\n});`,
      });
    }
    if (Number.isInteger(value)) {
      snippets.push({
        label: 'Is an integer',
        snippet: `apx.test(${nameExpr('is an integer')}, () => {\n  apx.expect(${access}).to.be.integer;\n});`,
      });
    }
  } else if (typeof value === 'string') {
    const quoted = JSON.stringify(value);
    const displayValue = value.length > 30 ? `${value.slice(0, 27)}...` : value;
    snippets.push({
      label: `Equals "${displayValue}"`,
      snippet: `apx.test(${nameExpr(`equals ${value}`)}, () => {\n  apx.expect(${access}).to.eql(${quoted});\n});`,
    });
    snippets.push({
      label: 'Is not empty',
      snippet: `apx.test(${nameExpr('is not empty')}, () => {\n  apx.expect(${access}).to.not.be.empty;\n});`,
    });
    if (value.length > 0 && value.length <= 30) {
      snippets.push({
        label: `Contains "${displayValue}"`,
        snippet: `apx.test(${nameExpr(`contains ${value}`)}, () => {\n  apx.expect(${access}).to.include(${quoted});\n});`,
      });
    }
    snippets.push({
      label: 'Is a string',
      snippet: `apx.test(${nameExpr('is a string')}, () => {\n  apx.expect(${access}).to.be.a('string');\n});`,
    });
  }

  snippets.push({
    label: 'Exists (not null/undefined)',
    snippet: `apx.test(${nameExpr('exists')}, () => {\n  apx.expect(${access}).to.exist;\n});`,
  });

  return snippets;
}
