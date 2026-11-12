import { generateDocs } from '@apilix/core/docs';
import type { AppCollection, AppEnvironment, DocsExportOptions, DocsResult } from '../types';
import { DOC_SNIPPET_LANGUAGES } from './docsCodeGenAdapter';
import { maskSecrets } from './secretMask';

export interface DocsExportContext {
  /** Environment used for 'resolve' mode. Secret rows are never substituted. */
  environment?: AppEnvironment | null;
  /** Plaintext secret values (active env + globals) masked from the final output. */
  secretValues?: Set<string>;
}

/**
 * Every rendering of a secret that can appear in generated output: raw, HTML
 * entities, JSON/YAML double-quoted escapes, markdown table cells and
 * URL-encoded. Secrets with & < > " ' \\ or newlines would otherwise slip past a
 * raw-text mask once an output format escapes them.
 */
export function secretVariants(secret: string): string[] {
  const variants = new Set<string>([secret]);
  variants.add(secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  variants.add(secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  variants.add(JSON.stringify(secret).slice(1, -1));
  variants.add(secret.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>'));
  variants.add(secret.replace(/\r?\n/g, '<br>'));
  variants.add(secret.replace(/\r?\n/g, '\n'));
  variants.add(encodeURIComponent(secret));
  // Single-quoted shell/YAML style escaping ('"'"').
  variants.add(secret.replace(/'/g, "'\\''"));
  return [...variants].filter(v => v.length > 0);
}

/** Expand a secret set with the escaped forms of every secret. */
export function expandSecretSet(secrets: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const s of secrets) for (const v of secretVariants(s)) out.add(v);
  return out;
}

function maskDeep<T>(value: T, secrets: Set<string>): T {
  if (typeof value === 'string') return maskSecrets(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map(v => maskDeep(v, secrets)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskSecrets(k, secrets), maskDeep(v, secrets)])) as T;
  }
  return value;
}

/** Split an environment into substitutable (non-secret) vars and secret key names. */
export function splitEnvironmentVars(env: AppEnvironment | null | undefined): {
  variables: Record<string, string>;
  secretKeys: string[];
} {
  const variables: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const row of env?.values ?? []) {
    if (!row.key || row.enabled === false) continue;
    if (row.secret) secretKeys.push(row.key);
    else variables[row.key] = row.value;
  }
  return { variables, secretKeys };
}

/**
 * Generate documentation for a collection. Wraps @apilix/core/docs, injects the
 * client snippet generators, restricts variable substitution to non-secret
 * environment values, and applies a final secret-masking pass to the output.
 */
export function exportCollectionDocs(
  collection: AppCollection,
  options: DocsExportOptions,
  ctx: DocsExportContext = {},
): DocsResult {
  const { variables, secretKeys } = splitEnvironmentVars(ctx.environment);
  const opts: DocsExportOptions = {
    ...options,
    variables: options.variableMode === 'resolve' ? variables : undefined,
    secretVariableKeys: secretKeys,
  };
  const hasSecrets = !!ctx.secretValues && ctx.secretValues.size > 0;
  const secrets = hasSecrets ? expandSecretSet(ctx.secretValues as Set<string>) : new Set<string>();
  // Mask on the source model first: escaping done by the renderers and snippet
  // generators (HTML entities, shell quoting, JSON) then never sees a secret.
  const source = hasSecrets ? maskDeep(collection, secrets) : collection;
  const result = generateDocs(source, opts, { snippetLanguages: DOC_SNIPPET_LANGUAGES });
  if (!hasSecrets) return result;
  const content = maskSecrets(result.content, secrets);
  let spec = result.spec;
  if (spec) {
    const specText = JSON.stringify(spec);
    const maskedSpec = maskSecrets(specText, secrets);
    if (maskedSpec !== specText) {
      try { spec = JSON.parse(maskedSpec); } catch { spec = maskDeep(spec, secrets); }
    }
  }
  return { ...result, content, spec };
}

/** Build a safe default filename for a docs export. */
export function docsFilename(collectionName: string, result: Pick<DocsResult, 'format' | 'extension'>): string {
  const safe = collectionName.replace(/[^a-z0-9_\-. ]/gi, '_').trim() || 'collection';
  const suffix = result.format === 'openapi' ? '.openapi' : '.docs';
  return `${safe}${suffix}.${result.extension}`;
}
