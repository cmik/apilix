import { load as yamlLoad } from 'js-yaml';
import type { CollectionItem, CollectionHeader, CollectionQueryParam, CollectionBody, CollectionAuth, OAuth2Config } from '../types';

// ─── OpenAPI / Swagger type stubs ────────────────────────────────────────────

interface OaParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie' | 'body' | 'formData';
  description?: string;
  required?: boolean;
  schema?: { type?: string; example?: unknown; default?: unknown };
  example?: unknown;
  type?: string; // Swagger 2.0
}

interface OaMediaObject {
  schema?: {
    type?: string;
    example?: unknown;
    properties?: Record<string, { type?: string; example?: unknown; description?: string }>;
  };
  example?: unknown;
}

interface OaOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OaParameter[];
  requestBody?: {
    content?: Record<string, OaMediaObject>;
    description?: string;
  };
  // Swagger 2.0 body param is in parameters
}

// ─── Security Scheme types ────────────────────────────────────────────────────

interface OaOAuth2Flow {
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: Record<string, string>;
}

interface OaSecurityScheme {
  type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect' | 'basic'; // 'basic' for Swagger 2.x
  scheme?: string;     // http: 'bearer' | 'basic' | 'digest' etc.
  in?: 'header' | 'query' | 'cookie';
  name?: string;       // apiKey: header/query param name
  // OpenAPI 3.x OAuth2
  flows?: {
    authorizationCode?: OaOAuth2Flow;
    clientCredentials?: OaOAuth2Flow;
    implicit?: OaOAuth2Flow;
    password?: OaOAuth2Flow;
  };
  // Swagger 2.x OAuth2
  flow?: 'implicit' | 'password' | 'application' | 'accessCode';
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: Record<string, string>;
}

interface OaPathItem {
  get?: OaOperation;
  post?: OaOperation;
  put?: OaOperation;
  patch?: OaOperation;
  delete?: OaOperation;
  head?: OaOperation;
  options?: OaOperation;
  parameters?: OaParameter[];
}

interface OaSpec {
  openapi?: string;   // 3.x
  swagger?: string;   // 2.0
  info?: { title?: string; version?: string };
  servers?: Array<{ url: string }>;
  host?: string;      // Swagger 2.0
  basePath?: string;  // Swagger 2.0
  schemes?: string[]; // Swagger 2.0
  paths?: Record<string, OaPathItem>;
  // OpenAPI 3.x security schemes
  components?: {
    securitySchemes?: Record<string, OaSecurityScheme>;
  };
  // Swagger 2.0 security definitions
  securityDefinitions?: Record<string, OaSecurityScheme>;
  // Top-level security requirements (applies to all operations)
  security?: Array<Record<string, string[]>>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

function extractExample(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function buildExampleObject(
  properties: Record<string, { type?: string; example?: unknown; description?: string }>
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.example !== undefined) {
      obj[key] = prop.example;
    } else {
      switch (prop.type) {
        case 'string': obj[key] = ''; break;
        case 'integer':
        case 'number': obj[key] = 0; break;
        case 'boolean': obj[key] = false; break;
        case 'array': obj[key] = []; break;
        case 'object': obj[key] = {}; break;
        default: obj[key] = '';
      }
    }
  }
  return obj;
}

function buildRawBody(media: OaMediaObject): string {
  if (media.example !== undefined) return extractExample(media.example);
  if (media.schema) {
    if (media.schema.example !== undefined) return extractExample(media.schema.example);
    if (media.schema.properties) {
      return JSON.stringify(buildExampleObject(media.schema.properties), null, 2);
    }
    if (media.schema.type === 'object') return '{}';
    if (media.schema.type === 'array') return '[]';
  }
  return '';
}

function paramExample(p: OaParameter): string {
  if (p.example !== undefined) return extractExample(p.example);
  if (p.schema?.example !== undefined) return extractExample(p.schema.example);
  if (p.schema?.default !== undefined) return extractExample(p.schema.default);
  return '';
}

// ─── Main converter ───────────────────────────────────────────────────────────

export interface ParsedOpenApiResult {
  collectionName: string;
  items: CollectionItem[];
  collectionAuth?: CollectionAuth;
}

/** Preview metadata for a single OpenAPI operation, used to populate the
 * request-selection UI before committing to a full import. */
export interface OpenApiRequestPreview {
  id: string;
  method: string;
  path: string;
  name: string;
  tag?: string;
  /** Full URL string built from the spec base URL + path + query parameters. */
  rawUrl: string;
  /** Origin (scheme + host) extracted from `rawUrl`, if the URL is absolute. */
  host?: string;
}

/** A host-to-replacement mapping used by `applyOpenApiHostReplacements`. */
export interface OpenApiHostReplacement {
  from: string;
  to: string;
}

/**
 * Options passed from the import UI to `useImportFile` for OpenAPI imports.
 * Both properties are optional and independent of each other.
 */
export interface OpenApiImportOptions {
  /** When present (even as an empty array), activates request filtering.
   * Only items whose IDs appear in this array are included in the import.
   * An empty array causes the import to be aborted with an error toast. */
  selectedRequestIds?: string[];
  /** Host-rewrite rules. Applied after filtering. Rules with a blank `to`
   * value are silently skipped. Only the first matching rule per URL wins. */
  hostReplacements?: OpenApiHostReplacement[];
}

/** Full parse result returned by `parseOpenApiSpecWithPreview`, extending the
 * base result with the data needed to render the import preview UI. */
export interface ParsedOpenApiPreviewResult extends ParsedOpenApiResult {
  requestPreviews: OpenApiRequestPreview[];
  detectedHosts: string[];
}

function makeOperationId(method: string, pathStr: string): string {
  return `oa:${method.toUpperCase()}:${pathStr}`;
}

function detectHost(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
}

// ─── Security scheme → CollectionAuth ────────────────────────────────────────

function securitySchemeToAuth(scheme: OaSecurityScheme): CollectionAuth | undefined {
  const t = scheme.type;

  // HTTP bearer
  if (t === 'http' && scheme.scheme?.toLowerCase() === 'bearer') {
    return { type: 'bearer', bearer: [{ key: 'token', value: '', type: 'string' }] };
  }

  // HTTP basic (OpenAPI 3.x) or Swagger 2.x 'basic'
  if ((t === 'http' && scheme.scheme?.toLowerCase() === 'basic') || t === 'basic') {
    return {
      type: 'basic',
      basic: [
        { key: 'username', value: '', type: 'string' },
        { key: 'password', value: '', type: 'string' },
      ],
    };
  }

  // HTTP digest
  if (t === 'http' && scheme.scheme?.toLowerCase() === 'digest') {
    return { type: 'digest' };
  }

  // API Key
  if (t === 'apiKey') {
    return {
      type: 'apikey',
      apikey: [
        { key: 'key', value: scheme.name || 'X-API-Key', type: 'string' },
        { key: 'value', value: '', type: 'string' },
        { key: 'in', value: scheme.in || 'header', type: 'string' },
      ],
    };
  }

  // OAuth2
  if (t === 'oauth2') {
    // OpenAPI 3.x: only map flows we can represent accurately
    if (scheme.flows) {
      const { authorizationCode, clientCredentials } = scheme.flows;

      if (authorizationCode) {
        const scopes = Object.keys(authorizationCode.scopes ?? {});
        const oauth2Config: OAuth2Config = {
          grantType: 'authorization_code',
          clientId: '',
          clientSecret: '',
          tokenUrl: authorizationCode.tokenUrl ?? '',
          authorizationUrl: authorizationCode.authorizationUrl ?? '',
          scopes,
        };
        return { type: 'oauth2', oauth2: oauth2Config };
      }

      if (clientCredentials) {
        const scopes = Object.keys(clientCredentials.scopes ?? {});
        const oauth2Config: OAuth2Config = {
          grantType: 'client_credentials',
          clientId: '',
          clientSecret: '',
          tokenUrl: clientCredentials.tokenUrl ?? '',
          authorizationUrl: clientCredentials.authorizationUrl ?? '',
          scopes,
        };
        return { type: 'oauth2', oauth2: oauth2Config };
      }

      return { type: 'oauth2' };
    }

    // Swagger 2.x: only map flows we can represent accurately
    if (scheme.flow === 'accessCode' || scheme.flow === 'application') {
      const grantType = scheme.flow === 'accessCode'
        ? 'authorization_code'
        : 'client_credentials';
      const scopes = Object.keys(scheme.scopes ?? {});
      const oauth2Config: OAuth2Config = {
        grantType,
        clientId: '',
        clientSecret: '',
        tokenUrl: scheme.tokenUrl ?? '',
        authorizationUrl: scheme.authorizationUrl ?? '',
        scopes,
      };
      return { type: 'oauth2', oauth2: oauth2Config };
    }

    return { type: 'oauth2' };
  }

  // openIdConnect — treat as bearer
  if (t === 'openIdConnect') {
    return { type: 'bearer', bearer: [{ key: 'token', value: '', type: 'string' }] };
  }

  return undefined;
}

function resolveTopLevelAuth(spec: OaSpec): CollectionAuth | undefined {
  const schemes: Record<string, OaSecurityScheme> =
    spec.components?.securitySchemes ??
    spec.securityDefinitions ??
    {};

  if (Object.keys(schemes).length === 0) return undefined;

  // If a top-level security requirement is declared, honour its first entry
  let chosenName: string | undefined;
  if (spec.security && spec.security.length > 0) {
    chosenName = Object.keys(spec.security[0])[0];
  }
  // Otherwise fall back to the first defined scheme
  chosenName = chosenName ?? Object.keys(schemes)[0];

  const scheme = schemes[chosenName];
  return scheme ? securitySchemeToAuth(scheme) : undefined;
}

/**
 * Parses an OpenAPI 3.x or Swagger 2.0 spec and returns the full collection
 * tree **plus** preview metadata for the import UI.
 *
 * @param text - Raw YAML or JSON spec text.
 * @param filename - Optional filename used as a fallback collection name.
 * @returns Parsed collection items, auth, request previews, and detected hosts.
 * @throws If `text` is not a recognised OpenAPI/Swagger document.
 */
export function parseOpenApiSpecWithPreview(text: string, filename?: string): ParsedOpenApiPreviewResult {
  // Parse YAML or JSON
  let spec: OaSpec;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    spec = JSON.parse(text) as OaSpec;
  } else {
    spec = yamlLoad(text) as OaSpec;
  }

  if (!spec || (!spec.openapi && !spec.swagger)) {
    throw new Error('Not a recognised OpenAPI 3.x or Swagger 2.0 specification.');
  }

  const isSwagger2 = !!spec.swagger;
  const collectionName = spec.info?.title || filename?.replace(/\.(yaml|yml|json)$/i, '') || 'OpenAPI Import';

  // Build base URL
  let baseUrl = '';
  if (!isSwagger2 && spec.servers && spec.servers.length > 0) {
    baseUrl = spec.servers[0].url.replace(/\/$/, '');
  } else if (isSwagger2) {
    const scheme = (spec.schemes && spec.schemes[0]) || 'https';
    const host = spec.host || '';
    const basePath = spec.basePath || '';
    baseUrl = host ? `${scheme}://${host}${basePath}` : basePath;
  }

  const paths = spec.paths || {};

  // Collect items grouped by first tag
  const tagMap = new Map<string, CollectionItem[]>();
  const untagged: CollectionItem[] = [];
  const requestPreviews: OpenApiRequestPreview[] = [];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    const pathLevelParams: OaParameter[] = pathItem.parameters || [];

    for (const method of HTTP_METHODS) {
      const operation: OaOperation | undefined = pathItem[method as HttpMethod];
      if (!operation) continue;

      const allParams: OaParameter[] = [...pathLevelParams, ...(operation.parameters || [])];

      // Build URL with base
      const rawUrl = `${baseUrl}${pathStr}`;

      // Query params
      const queryParams: CollectionQueryParam[] = allParams
        .filter(p => p.in === 'query')
        .map(p => ({ key: p.name, value: paramExample(p), description: p.description }));

      // Headers
      const headers: CollectionHeader[] = allParams
        .filter(p => p.in === 'header')
        .map(p => ({ key: p.name, value: paramExample(p), description: p.description }));

      // Build URL object
      const urlWithQuery = queryParams.length > 0
        ? `${rawUrl}?${queryParams.map(q => `${q.key}=${q.value}`).join('&')}`
        : rawUrl;

      // Body
      let body: CollectionBody | undefined;

      if (isSwagger2) {
        const bodyParam = allParams.find(p => p.in === 'body');
        const formParams = allParams.filter(p => p.in === 'formData');
        if (bodyParam) {
          const example = bodyParam.schema?.example !== undefined
            ? extractExample(bodyParam.schema.example)
            : '{}';
          body = { mode: 'raw', raw: example, options: { raw: { language: 'json' } } };
        } else if (formParams.length > 0) {
          body = {
            mode: 'formdata',
            formdata: formParams.map(p => ({ key: p.name, value: paramExample(p), description: p.description })),
          };
        }
      } else if (operation.requestBody?.content) {
        const content = operation.requestBody.content;
        if (content['application/json']) {
          body = {
            mode: 'raw',
            raw: buildRawBody(content['application/json']),
            options: { raw: { language: 'json' } },
          };
        } else if (content['application/x-www-form-urlencoded']) {
          const media = content['application/x-www-form-urlencoded'];
          const pairs = media.schema?.properties
            ? Object.entries(media.schema.properties).map(([k, v]) => ({
                key: k,
                value: extractExample(v.example ?? ''),
                description: v.description,
              }))
            : [];
          body = { mode: 'urlencoded', urlencoded: pairs };
        } else if (content['multipart/form-data']) {
          const media = content['multipart/form-data'];
          const fields = media.schema?.properties
            ? Object.entries(media.schema.properties).map(([k, v]) => ({
                key: k,
                value: extractExample(v.example ?? ''),
                description: v.description,
              }))
            : [];
          body = { mode: 'formdata', formdata: fields };
        }
      }

      // Operation name
      const opName =
        operation.summary ||
        operation.operationId ||
        `${method.toUpperCase()} ${pathStr}`;

      const requestId = makeOperationId(method, pathStr);
      const tag = operation.tags?.[0];

      const item: CollectionItem = {
        id: requestId,
        name: opName,
        description: operation.description,
        request: {
          method: method.toUpperCase(),
          url: {
            raw: urlWithQuery,
            query: queryParams.length > 0 ? queryParams : undefined,
          },
          header: headers.length > 0 ? headers : [],
          body,
          description: operation.description,
        },
      };

      requestPreviews.push({
        id: requestId,
        method: method.toUpperCase(),
        path: pathStr,
        name: opName,
        tag,
        rawUrl: urlWithQuery,
        host: detectHost(urlWithQuery),
      });

      // Group by tag
      if (tag) {
        if (!tagMap.has(tag)) tagMap.set(tag, []);
        tagMap.get(tag)!.push(item);
      } else {
        untagged.push(item);
      }
    }
  }

  // Build final item list — one folder per tag
  const items: CollectionItem[] = [];
  for (const [tag, tagItems] of tagMap.entries()) {
    items.push({
      id: crypto.randomUUID(),
      name: tag,
      item: tagItems,
    });
  }
  items.push(...untagged);

  const collectionAuth = resolveTopLevelAuth(spec);
  const detectedHosts = Array.from(new Set(requestPreviews.map(r => r.host).filter((h): h is string => !!h)));

  return { collectionName, items, collectionAuth, requestPreviews, detectedHosts };
}

/**
 * Convenience wrapper around `parseOpenApiSpecWithPreview` that strips the
 * preview-only fields. Use this when you do not need the preview UI data.
 *
 * @param text - Raw YAML or JSON spec text.
 * @param filename - Optional filename used as a fallback collection name.
 */
export function parseOpenApiSpec(text: string, filename?: string): ParsedOpenApiResult {
  const { collectionName, items, collectionAuth } = parseOpenApiSpecWithPreview(text, filename);
  return { collectionName, items, collectionAuth };
}

/** Re-assign fresh IDs to every item node so that repeated imports of the same
 * spec never produce duplicate IDs in the store. */
export function assignFreshIds(items: CollectionItem[]): CollectionItem[] {
  return items.map(node => {
    if (node.item) {
      return { ...node, id: crypto.randomUUID(), item: assignFreshIds(node.item) };
    }
    return { ...node, id: crypto.randomUUID() };
  });
}

/**
 * Recursively prunes a collection item tree to include only the request nodes
 * whose IDs appear in `selectedRequestIds`. Empty folders (all children
 * filtered out) are removed.
 *
 * @param items - Root-level items from a parsed OpenAPI collection.
 * @param selectedRequestIds - IDs of the request items to keep.
 * @returns Pruned item tree. May be empty if no IDs match.
 */
export function filterOpenApiItemsByRequestIds(items: CollectionItem[], selectedRequestIds: string[]): CollectionItem[] {
  const selected = new Set(selectedRequestIds);

  function filterNode(node: CollectionItem): CollectionItem | null {
    if (node.item) {
      const children = node.item.map(filterNode).filter((child): child is CollectionItem => !!child);
      if (children.length === 0) return null;
      return { ...node, item: children };
    }

    if (!node.request) return null;
    return node.id && selected.has(node.id) ? { ...node } : null;
  }

  return items.map(filterNode).filter((item): item is CollectionItem => !!item);
}

function replaceHostInRawUrl(rawUrl: string, rules: OpenApiHostReplacement[]): string {
  let next = rawUrl;
  for (const rule of rules) {
    if (!rule.from || !rule.to) continue;
    if (next.startsWith(rule.from)) {
      next = `${rule.to}${next.slice(rule.from.length)}`;
      break; // only the first matching rule wins
    }
  }
  return next;
}

/**
 * Rewrites the `raw` URL of every request item in the tree by applying
 * `replacements` in order. Only the first matching rule per URL takes effect.
 * Rules with a blank `from` or `to` are skipped.
 *
 * @param items - Collection item tree to rewrite.
 * @param replacements - Ordered list of `{ from, to }` host replacement rules.
 * @returns New item tree with URLs rewritten (original tree is not mutated).
 */
export function applyOpenApiHostReplacements(items: CollectionItem[], replacements: OpenApiHostReplacement[]): CollectionItem[] {
  const rules = replacements.filter(r => r.from.trim() && r.to.trim()).map(r => ({ from: r.from.trim(), to: r.to.trim() }));
  if (rules.length === 0) return items;

  function mapNode(node: CollectionItem): CollectionItem {
    if (node.item) {
      return { ...node, item: node.item.map(mapNode) };
    }

    if (!node.request) return { ...node };

    if (typeof node.request.url === 'string') {
      return {
        ...node,
        request: {
          ...node.request,
          url: replaceHostInRawUrl(node.request.url, rules),
        },
      };
    }

    const nextRaw = replaceHostInRawUrl(node.request.url.raw, rules);
    return {
      ...node,
      request: {
        ...node.request,
        url: {
          ...node.request.url,
          raw: nextRaw,
        },
      },
    };
  }

  return items.map(mapNode);
}
