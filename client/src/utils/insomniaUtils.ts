// ─── Insomnia v4 Export Importer ─────────────────────────────────────────────
// Parses Insomnia export format v4 (the default JSON export from Insomnia)
// into Apilix AppCollection(s) and AppEnvironment(s).
//
// Insomnia export structure:
// {
//   "__export_format": 4,
//   "resources": [
//     { "_id": "wrk_…", "_type": "workspace", … },
//     { "_id": "fld_…", "_type": "request_group", parentId: "wrk_…", … },
//     { "_id": "req_…", "_type": "request", parentId: "wrk_…"|"fld_…", … },
//     { "_id": "env_…", "_type": "environment", parentId: "wrk_…", … },
//   ]
// }

import { generateId } from '../store';
import type {
  AppCollection,
  AppEnvironment,
  CollectionItem,
  CollectionAuth,
  CollectionBody,
  CollectionHeader,
  CollectionQueryParam,
  CollectionUrl,
} from '../types';

// ─── Raw Insomnia types ───────────────────────────────────────────────────────

interface InsomniaExport {
  __export_format: number;
  resources: InsomniaResource[];
}

interface InsomniaBase {
  _id: string;
  _type: string;
  parentId: string | null;
  name: string;
}

interface InsomniaWorkspace extends InsomniaBase {
  _type: 'workspace';
  parentId: null;
}

interface InsomniaRequestGroup extends InsomniaBase {
  _type: 'request_group';
  parentId: string;
}

interface InsomniaHeader {
  name: string;
  value: string;
  disabled?: boolean;
}

interface InsomniaParam {
  name: string;
  value: string;
  disabled?: boolean;
}

interface InsomniaBody {
  mimeType?: string;
  text?: string;
  params?: InsomniaParam[];
}

interface InsomniaAuthentication {
  type?: string;
  disabled?: boolean;
  // bearer
  token?: string;
  // basic
  username?: string;
  password?: string;
  // apikey
  key?: string;
  value?: string;
  addTo?: string; // 'header' | 'queryParams'
}

interface InsomniaRequest extends InsomniaBase {
  _type: 'request';
  parentId: string;
  method: string;
  url: string;
  headers?: InsomniaHeader[];
  parameters?: InsomniaParam[];
  body?: InsomniaBody;
  authentication?: InsomniaAuthentication;
  description?: string;
}

interface InsomniaEnvironment extends InsomniaBase {
  _type: 'environment';
  parentId: string;
  data?: Record<string, unknown>;
}

type InsomniaResource =
  | InsomniaWorkspace
  | InsomniaRequestGroup
  | InsomniaRequest
  | InsomniaEnvironment
  | (InsomniaBase & { _type: string });

// ─── Public result type ───────────────────────────────────────────────────────

export interface InsomniaParseResult {
  collections: AppCollection[];
  environments: AppEnvironment[];
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Returns true when the value looks like an Insomnia v4 export.
 */
export function isInsomniaExport(json: unknown): json is InsomniaExport {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const obj = json as Record<string, unknown>;
  return obj.__export_format === 4 && Array.isArray(obj.resources);
}

// ─── Auth converter ───────────────────────────────────────────────────────────

function convertAuth(auth: InsomniaAuthentication | undefined): CollectionAuth | undefined {
  if (!auth || !auth.type || auth.disabled) return { type: 'noauth' };
  switch (auth.type) {
    case 'bearer':
      return {
        type: 'bearer',
        bearer: [{ key: 'token', value: auth.token ?? '' }],
      };
    case 'basic':
      return {
        type: 'basic',
        basic: [
          { key: 'username', value: auth.username ?? '' },
          { key: 'password', value: auth.password ?? '' },
        ],
      };
    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: auth.key ?? '' },
          { key: 'value', value: auth.value ?? '' },
          { key: 'in', value: auth.addTo === 'queryParams' ? 'query' : 'header' },
        ],
      };
    case 'oauth2':
      return { type: 'oauth2' };
    default:
      return { type: 'noauth' };
  }
}

// ─── Body converter ───────────────────────────────────────────────────────────

function convertBody(body: InsomniaBody | undefined): CollectionBody | undefined {
  if (!body) return undefined;
  const mime = (body.mimeType ?? '').toLowerCase();

  if (mime === 'application/json') {
    return {
      mode: 'raw',
      raw: body.text ?? '',
      options: { raw: { language: 'json' } },
    };
  }

  if (
    mime === 'text/plain' ||
    mime === 'text/html' ||
    mime === 'text/xml' ||
    mime === 'application/xml'
  ) {
    const language = mime.includes('xml') ? 'xml' : 'text';
    return {
      mode: 'raw',
      raw: body.text ?? '',
      options: { raw: { language: language as 'xml' | 'text' } },
    };
  }

  if (mime === 'application/x-www-form-urlencoded') {
    return {
      mode: 'urlencoded',
      urlencoded: (body.params ?? [])
        .filter(p => !p.disabled)
        .map(p => ({ key: p.name, value: p.value })),
    };
  }

  if (mime === 'multipart/form-data') {
    return {
      mode: 'formdata',
      formdata: (body.params ?? [])
        .filter(p => !p.disabled)
        .map(p => ({ key: p.name, value: p.value })),
    };
  }

  if (mime === 'application/graphql') {
    let query = '';
    let variables: string | undefined;
    try {
      const parsed = JSON.parse(body.text ?? '{}');
      query = typeof parsed.query === 'string' ? parsed.query : (body.text ?? '');
      variables = parsed.variables ? JSON.stringify(parsed.variables, null, 2) : undefined;
    } catch {
      query = body.text ?? '';
    }
    return {
      mode: 'graphql',
      graphql: { query, ...(variables !== undefined && { variables }) },
    };
  }

  // Any other mimeType with text — store as raw
  if (body.text !== undefined && body.text !== '') {
    return { mode: 'raw', raw: body.text };
  }

  return undefined;
}

// ─── Request converter ────────────────────────────────────────────────────────

function convertRequest(r: InsomniaRequest): CollectionItem {
  const enabledHeaders: CollectionHeader[] = (r.headers ?? [])
    .filter(h => !h.disabled)
    .map(h => ({ key: h.name, value: h.value }));

  const enabledParams: CollectionQueryParam[] = (r.parameters ?? [])
    .filter(p => !p.disabled)
    .map(p => ({ key: p.name, value: p.value }));

  const url: CollectionUrl = {
    raw: r.url,
    ...(enabledParams.length > 0 && { query: enabledParams }),
  };

  const auth = convertAuth(r.authentication);
  const body = convertBody(r.body);

  return {
    id: generateId(),
    name: r.name,
    request: {
      method: (r.method || 'GET').toUpperCase(),
      url,
      ...(enabledHeaders.length > 0 && { header: enabledHeaders }),
      ...(body && { body }),
      ...(auth && auth.type !== 'noauth' && { auth }),
      ...(r.description && { description: r.description }),
    },
  };
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parses an Insomnia v4 export into Apilix collections and environments.
 * Throws if `json` is not a valid Insomnia v4 export.
 */
export function parseInsomniaExport(json: unknown): InsomniaParseResult {
  if (!isInsomniaExport(json)) {
    throw new Error('Not a valid Insomnia v4 export (missing __export_format: 4 or resources array).');
  }

  const resources = json.resources;

  // Group resources by type
  const workspaces: InsomniaWorkspace[] = [];
  const groups: InsomniaRequestGroup[] = [];
  const requests: InsomniaRequest[] = [];
  const environments: InsomniaEnvironment[] = [];

  for (const r of resources) {
    if (r._type === 'workspace') workspaces.push(r as InsomniaWorkspace);
    else if (r._type === 'request_group') groups.push(r as InsomniaRequestGroup);
    else if (r._type === 'request') requests.push(r as InsomniaRequest);
    else if (r._type === 'environment') environments.push(r as InsomniaEnvironment);
  }

  // Build a parentId → children map for requests and groups
  const childrenOf = new Map<string, InsomniaResource[]>();
  for (const r of [...groups, ...requests]) {
    const pid = (r as InsomniaBase).parentId;
    if (!pid) continue;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(r);
  }

  // Recursively build CollectionItem[] for a given parent ID.
  // The `visited` set guards against circular parentId references in tampered exports.
  function buildItems(parentId: string, visited = new Set<string>()): CollectionItem[] {
    if (visited.has(parentId)) return [];
    visited.add(parentId);
    const children = childrenOf.get(parentId) ?? [];
    return children.map(child => {
      if (child._type === 'request_group') {
        const grp = child as InsomniaRequestGroup;
        return {
          id: generateId(),
          name: grp.name,
          item: buildItems(grp._id, visited),
        } satisfies CollectionItem;
      }
      // 'request'
      return convertRequest(child as InsomniaRequest);
    });
  }

  // Build one AppCollection per workspace
  const collections: AppCollection[] = workspaces.map(ws => ({
    _id: generateId(),
    info: {
      name: ws.name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: buildItems(ws._id),
  }));

  // Build AppEnvironment for each environment resource that has data
  const appEnvironments: AppEnvironment[] = environments
    .filter(env => env.data && Object.keys(env.data).length > 0)
    .map(env => {
      const values = Object.entries(env.data!)
        .filter(([key]) => key !== '')
        .map(([key, val]) => ({
          key,
          value: typeof val === 'string' ? val : JSON.stringify(val),
          type: 'text',
          enabled: true,
        }));
      return {
        _id: generateId(),
        name: env.name,
        values,
      };
    });

  return { collections, environments: appEnvironments };
}
