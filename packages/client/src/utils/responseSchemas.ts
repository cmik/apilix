import type { CollectionEvent, CollectionItem, ResponseSchema, ResponseSchemaLink, SchemaRunMode } from '../types';
import { updateItemById, findItemInTree } from './treeHelpers';

export const SCHEMA_HISTORY_CAP = 10;
export const SCHEMA_RUN_MODES: SchemaRunMode[] = ['off', 'warn', 'strict'];
export const DEFAULT_SCHEMA_TIMEOUT_MS = 2000;
export const MIN_SCHEMA_TIMEOUT_MS = 100;
export const MAX_SCHEMA_TIMEOUT_MS = 10000;
/** Mirrors @apilix/core clampTimeoutMs: non-numeric -> default, otherwise clamped to [100, 10000]. */
export function clampSchemaTimeoutMs(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SCHEMA_TIMEOUT_MS;
  return Math.min(MAX_SCHEMA_TIMEOUT_MS, Math.max(MIN_SCHEMA_TIMEOUT_MS, Math.round(v)));
}
export const SCHEMA_RUN_MODE_KEY = 'apilix_schema_run_mode';

export function normalizeSchemaName(name: string): string {
  return name.trim().toLowerCase();
}

/** True when another schema already uses this name (case-insensitive). */
export function isSchemaNameTaken(schemas: ResponseSchema[], name: string, exceptId?: string): boolean {
  const n = normalizeSchemaName(name);
  return schemas.some(s => s.id !== exceptId && normalizeSchemaName(s.name) === n);
}

/** Validation message for a schema name, or null when it is usable. */
export function validateSchemaName(schemas: ResponseSchema[], name: string, exceptId?: string): string | null {
  const t = name.trim();
  if (!t) return 'A name is required';
  if (t.length > 100) return 'The name must be at most 100 characters';
  if (isSchemaNameTaken(schemas, t, exceptId)) return `A schema named "${t}" already exists`;
  return null;
}

/** Make `name` unique among `schemas` by appending " (2)", " (3)"… */
export function uniqueSchemaName(schemas: ResponseSchema[], name: string): string {
  if (!isSchemaNameTaken(schemas, name)) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${name} (${i})`;
    if (!isSchemaNameTaken(schemas, candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
}

export function addSchema(schemas: ResponseSchema[], schema: ResponseSchema): ResponseSchema[] {
  if (validateSchemaName(schemas, schema.name)) return schemas;
  if (schemas.some(s => s.id === schema.id)) return schemas;
  const now = new Date().toISOString();
  return [...schemas, { ...schema, name: schema.name.trim(), version: schema.version || 1, createdAt: schema.createdAt ?? now, updatedAt: schema.updatedAt ?? now }];
}

/**
 * Apply a patch. A change of the JSON Schema itself bumps `version` and pushes the previous
 * content on `history` (newest first, capped). Name/description-only edits do not bump the version.
 * A name that collides is rejected (schemas returned unchanged).
 */
export function updateSchema(
  schemas: ResponseSchema[],
  id: string,
  patch: Partial<Pick<ResponseSchema, 'name' | 'description' | 'schema'>>,
): ResponseSchema[] {
  const current = schemas.find(s => s.id === id);
  if (!current) return schemas;
  if (patch.name !== undefined && validateSchemaName(schemas, patch.name, id)) return schemas;
  const now = new Date().toISOString();
  const contentChanged = patch.schema !== undefined && JSON.stringify(patch.schema) !== JSON.stringify(current.schema);
  const next: ResponseSchema = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    updatedAt: now,
  };
  if (contentChanged) {
    next.schema = patch.schema!;
    next.version = (current.version || 1) + 1;
    next.history = [{ version: current.version || 1, schema: current.schema, updatedAt: current.updatedAt ?? now }, ...(current.history ?? [])].slice(0, SCHEMA_HISTORY_CAP);
  }
  return schemas.map(s => (s.id === id ? next : s));
}

function mapRequestItems(items: CollectionItem[], fn: (item: CollectionItem) => CollectionItem): CollectionItem[] {
  return items.map(it => {
    const mapped = it.item ? { ...it, item: mapRequestItems(it.item, fn) } : it;
    return mapped.request ? fn(mapped) : mapped;
  });
}

/** Set (or clear, when empty) the schema links of one request. */
export function withSchemaLinks(item: CollectionItem, links: ResponseSchemaLink[]): CollectionItem {
  if (!item.request) return item;
  const { apilix, ...rest } = item.request;
  const nextApilix = { ...(apilix ?? {}) };
  if (links.length > 0) nextApilix.schemaLinks = links.map(l => ({ ...l }));
  else delete nextApilix.schemaLinks;
  const hasExt = Object.keys(nextApilix).length > 0;
  return { ...item, request: { ...rest, ...(hasExt ? { apilix: nextApilix } : {}) } };
}

export function setRequestSchemaLinks(items: CollectionItem[], requestId: string, links: ResponseSchemaLink[]): CollectionItem[] {
  const target = findItemInTree(items, requestId);
  if (!target) return items;
  return updateItemById(items, requestId, withSchemaLinks(target, links));
}

/** Remove every link that points at `schemaId`. */
export function stripSchemaLinks(items: CollectionItem[], schemaId: string): CollectionItem[] {
  return mapRequestItems(items, item => {
    const links = item.request?.apilix?.schemaLinks;
    if (!links || !links.some(l => l.schemaId === schemaId)) return item;
    return withSchemaLinks(item, links.filter(l => l.schemaId !== schemaId));
  });
}

/** Like stripSchemaLinks but for one (possibly folder) item, e.g. the copy held by an open tab. Same reference when unchanged. */
export function stripItemSchemaLinks(item: CollectionItem, schemaId: string): CollectionItem {
  return stripSchemaLinks([item], schemaId)[0] ?? item;
}

export function getSchemaLinks(item: CollectionItem | null | undefined): ResponseSchemaLink[] {
  return item?.request?.apilix?.schemaLinks ?? [];
}

const IGNORED_KEYWORDS = new Set(['prefixItems', 'unevaluatedProperties', 'unevaluatedItems', 'dependentRequired', 'dependentSchemas', 'minContains', 'maxContains', '$dynamicRef', '$recursiveRef']);
const DATA_ONLY_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/**
 * JSON Schema 2019/2020 keywords found in a schema that the validator (draft-07, non-strict) silently ignores.
 * Keywords only: property names under `properties`/`$defs` and data under enum/const/default/examples are not reported.
 */
export function findIgnoredKeywords(schema: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 64) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (DATA_ONLY_KEYWORDS.has(k)) continue;
      if (SCHEMA_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
        Object.values(v as Record<string, unknown>).forEach(sub => walk(sub, depth + 1));
        continue;
      }
      if (IGNORED_KEYWORDS.has(k)) found.add(k);
      walk(v, depth + 1);
    }
  };
  walk(schema, 0);
  return [...found].sort();
}

export function loadSchemaRunMode(): SchemaRunMode {
  try {
    const v = localStorage.getItem(SCHEMA_RUN_MODE_KEY);
    return v === 'off' || v === 'warn' || v === 'strict' ? v : 'warn';
  } catch {
    return 'warn';
  }
}

export function saveSchemaRunMode(mode: SchemaRunMode): void {
  try { localStorage.setItem(SCHEMA_RUN_MODE_KEY, mode); } catch { /* ignore */ }
}

/** Same precedence as the runner: exact status, then Nxx, then default. */
export function resolveSchemaLink(links: ResponseSchemaLink[] | undefined, status: number): ResponseSchemaLink | null {
  if (!links || links.length === 0 || !Number.isInteger(status)) return null;
  const exact = String(status);
  const klass = `${Math.floor(status / 100)}xx`;
  const norm = (l: ResponseSchemaLink) => String(l.match).toLowerCase();
  return links.find(l => norm(l) === exact) ?? links.find(l => norm(l) === klass) ?? links.find(l => norm(l) === 'default') ?? null;
}

/** Registry shape sent to the server so a schema can `$ref` another by name. */
export function toSchemaRegistry(schemas: ResponseSchema[]): Array<{ name: string; schema: Record<string, unknown> }> {
  return schemas.map(s => ({ name: s.name, schema: s.schema }));
}

export function isValidLinkMatch(match: string): boolean {
  return /^[1-5][0-9]{2}$/.test(match) || /^[1-5]xx$/i.test(match) || match.toLowerCase() === 'default';
}

// ─── Postman interchange ─────────────────────────────────────────────────────

function collectLinkedSchemaIds(items: CollectionItem[], out: Set<string>): void {
  for (const it of items) {
    for (const l of it.request?.apilix?.schemaLinks ?? []) out.add(l.schemaId);
    if (it.item) collectLinkedSchemaIds(it.item, out);
  }
}

const MATCH_SCHEMA_RE = /matchSchema\s*\(\s*(?:'((?:[^'\\\n]|\\.){1,200})'|"((?:[^"\\\n]|\\.){1,200})")/g;
const MAX_SCRIPT_SCAN = 200_000;

/** Names passed as a string literal to matchSchema() in item/folder scripts (static scan, bounded). */
function collectScriptSchemaNames(items: CollectionItem[], events: CollectionEvent[] | undefined, out: Set<string>): void {
  const scan = (evs: CollectionEvent[] | undefined) => {
    for (const ev of evs ?? []) {
      const exec = ev?.script?.exec;
      const src = (Array.isArray(exec) ? exec.join('\n') : typeof exec === 'string' ? exec : '').slice(0, MAX_SCRIPT_SCAN);
      for (const m of src.matchAll(MATCH_SCHEMA_RE)) out.add((m[1] ?? m[2]).replace(/\\(.)/g, '$1'));
    }
  };
  scan(events);
  const walk = (list: CollectionItem[], depth: number) => {
    if (depth > 64) return;
    for (const it of list) {
      scan(it.event);
      if (it.item) walk(it.item, depth + 1);
    }
  };
  walk(items, 0);
}

function collectRefNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) { node.forEach(n => collectRefNames(n, out)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) out.add(v);
      else collectRefNames(v, out);
    }
  }
}

/** Schemas a collection depends on: those linked from its requests, those named in matchSchema('Name') script calls, plus the ones they `$ref` by name. */
export function schemasUsedByItems(items: CollectionItem[], all: ResponseSchema[], collectionEvents?: CollectionEvent[]): ResponseSchema[] {
  const ids = new Set<string>();
  collectLinkedSchemaIds(items, ids);
  const scriptNames = new Set<string>();
  collectScriptSchemaNames(items, collectionEvents, scriptNames);
  const picked = new Map<string, ResponseSchema>();
  const queue = all.filter(s => ids.has(s.id) || scriptNames.has(s.name));
  while (queue.length > 0) {
    const s = queue.shift()!;
    if (picked.has(s.id)) continue;
    picked.set(s.id, s);
    const refs = new Set<string>();
    collectRefNames(s.schema, refs);
    for (const name of refs) {
      const dep = all.find(x => x.name === name);
      if (dep && !picked.has(dep.id)) queue.push(dep);
    }
  }
  return all.filter(s => picked.has(s.id));
}

function isSchemaLike(v: unknown): v is ResponseSchema {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === 'string' && typeof s.name === 'string' && !!s.name.trim()
    && !!s.schema && typeof s.schema === 'object' && !Array.isArray(s.schema);
}

/** Sanitise `apilix.schemas` read from an imported collection (unknown input). */
export function readImportedSchemas(apilix: unknown): ResponseSchema[] {
  const list = (apilix && typeof apilix === 'object') ? (apilix as { schemas?: unknown }).schemas : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(isSchemaLike).slice(0, 500).map(s => ({
    id: s.id,
    name: s.name.trim().slice(0, 100),
    ...(typeof s.description === 'string' ? { description: s.description } : {}),
    schema: s.schema,
    version: typeof s.version === 'number' && s.version >= 1 ? Math.floor(s.version) : 1,
    ...(s.source === 'inferred' || s.source === 'manual' ? { source: s.source } : {}),
    ...(typeof s.createdAt === 'string' ? { createdAt: s.createdAt } : {}),
    ...(typeof s.updatedAt === 'string' ? { updatedAt: s.updatedAt } : {}),
  }));
}

/** Copy of `node` with every by-name `$ref` found in `renames` (old name -> new name) rewritten. */
function rewriteRefNames<T>(node: T, renames: Map<string, string>): T {
  if (Array.isArray(node)) return node.map(n => rewriteRefNames(n, renames)) as unknown as T;
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      Object.defineProperty(out, k, {
        value: k === '$ref' && typeof v === 'string' && renames.has(v) ? renames.get(v) : rewriteRefNames(v, renames),
        enumerable: true, writable: true, configurable: true,
      });
    }
    return out as T;
  }
  return node;
}

/**
 * Add imported schemas to the workspace. A schema whose id already exists is kept as is (reported in `skipped`);
 * a name clash with a different schema is resolved by renaming the incoming one, and `$ref`s by name in the
 * imported schemas are rewritten to the new name so references keep pointing at the imported copy.
 */
export function mergeImportedSchemas(existing: ResponseSchema[], incoming: ResponseSchema[]): { schemas: ResponseSchema[]; added: number; renamed: number; skipped: number; skippedNames: string[] } {
  let schemas = existing;
  let added = 0;
  let renamed = 0;
  const skippedNames: string[] = [];
  const renames = new Map<string, string>();
  const toAdd: Array<{ s: ResponseSchema; name: string }> = [];
  // Plan names first (against the library plus names already planned) so refs can be rewritten consistently.
  let planned = existing;
  for (const s of incoming) {
    if (existing.some(x => x.id === s.id) || toAdd.some(x => x.s.id === s.id)) { skippedNames.push(s.name); continue; }
    const name = uniqueSchemaName(planned, s.name);
    if (name !== s.name) { renamed++; renames.set(s.name, name); }
    planned = [...planned, { ...s, name }];
    toAdd.push({ s, name });
  }
  for (const { s, name } of toAdd) {
    const next = addSchema(schemas, { ...s, name, schema: renames.size > 0 ? rewriteRefNames(s.schema, renames) : s.schema });
    if (next !== schemas) added++;
    schemas = next;
  }
  return { schemas, added, renamed, skipped: skippedNames.length, skippedNames };
}

// ─── Schema library helpers ──────────────────────────────────────────────────

export interface SchemaUsage {
  collectionId: string;
  collectionName: string;
  requestId: string;
  requestName: string;
  match: string;
}

/** Every request (across the given collections) that links to `schemaId`. */
export function findSchemaUsage(
  collections: Array<{ _id: string; info: { name: string }; item: CollectionItem[] }>,
  schemaId: string,
): SchemaUsage[] {
  const out: SchemaUsage[] = [];
  const walk = (c: { _id: string; info: { name: string } }, items: CollectionItem[]) => {
    for (const it of items) {
      for (const l of it.request?.apilix?.schemaLinks ?? []) {
        if (l.schemaId === schemaId && it.id) {
          out.push({ collectionId: c._id, collectionName: c.info.name, requestId: it.id, requestName: it.name, match: String(l.match) });
        }
      }
      if (it.item) walk(c, it.item);
    }
  };
  for (const c of collections) walk(c, c.item);
  return out;
}

/** Other schemas that `$ref` `target` by name. */
export function findSchemaReferrers(schemas: ResponseSchema[], target: ResponseSchema): ResponseSchema[] {
  return schemas.filter(s => {
    if (s.id === target.id) return false;
    const refs = new Set<string>();
    collectRefNames(s.schema, refs);
    return refs.has(target.name);
  });
}

/** A copy of `source` with a fresh id, a unique "<name> copy" name, version 1 and no history. */
export function duplicateSchema(schemas: ResponseSchema[], source: ResponseSchema, newId: string): ResponseSchema {
  const now = new Date().toISOString();
  return {
    id: newId,
    name: uniqueSchemaName(schemas, `${source.name} copy`.slice(0, 100)),
    ...(source.description ? { description: source.description } : {}),
    schema: JSON.parse(JSON.stringify(source.schema)),
    version: 1,
    source: source.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
  };
}

export const SCHEMA_FILE_FORMAT = 'apilix-response-schemas';

/** JSON file content for exporting schemas (history is not exported). */
export function buildSchemaExport(schemas: ResponseSchema[]): Record<string, unknown> {
  return {
    format: SCHEMA_FILE_FORMAT,
    version: 1,
    schemas: schemas.map(s => ({
      id: s.id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      schema: s.schema,
      version: s.version,
      ...(s.source ? { source: s.source } : {}),
    })),
  };
}

/**
 * Parse an imported schema file: the export format, a bare array of schema entries, or a single plain JSON Schema
 * (named after its `title` or the file name). Unknown input yields an error message, never a throw.
 */
export function parseSchemaImport(text: string, fileName: string, newId: () => string): { schemas: ResponseSchema[] } | { error: string } {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { error: 'The file is not valid JSON' }; }
  if (Array.isArray(data) || (data && typeof data === 'object' && Array.isArray((data as { schemas?: unknown }).schemas))) {
    const list = Array.isArray(data) ? data : (data as { schemas: unknown[] }).schemas;
    const schemas = readImportedSchemas({ schemas: list });
    return schemas.length > 0 ? { schemas } : { error: 'No valid schema entries found in the file' };
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const base = fileName.replace(/\.[^.]+$/, '').trim();
    const name = (typeof obj.title === 'string' && obj.title.trim()) || base || 'Imported schema';
    return { schemas: [{ id: newId(), name: name.slice(0, 100), schema: obj, version: 1, source: 'manual' }] };
  }
  return { error: 'The file must contain a JSON Schema object or a list of schemas' };
}
