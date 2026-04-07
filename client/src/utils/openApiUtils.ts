import { load as yamlLoad } from 'js-yaml';
import type { CollectionItem, CollectionHeader, CollectionQueryParam, CollectionBody } from '../types';

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
}

export function parseOpenApiSpec(text: string, filename?: string): ParsedOpenApiResult {
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

      const item: CollectionItem = {
        id: crypto.randomUUID(),
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

      // Group by tag
      const tag = operation.tags?.[0];
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

  return { collectionName, items };
}
