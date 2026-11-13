import type { AiFeatureKey, AiSettings, AppCollection, AppEnvironment, CollectionItem, GlobalVariableMeta } from '../../types';

/** Context gathering for natural-language request generation. Names only: values never leave here. */

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_NEIGHBORS = 5;

/** True when AI is on, consented to, and the feature is enabled: the only gate before any AI call. */
export function aiFeatureReady(settings: AiSettings, feature: AiFeatureKey): boolean {
  return settings.enabled && settings.consentGiven && settings.features[feature] === true;
}

/** HTTP/REST request item: not GraphQL, SOAP, SQL, Mongo, database or WebSocket. */
export function isHttpRestItem(item: CollectionItem | null | undefined): boolean {
  const req = item?.request;
  if (!req || item?.item) return false;
  if (req.requestType && req.requestType !== 'http') return false;
  if (req.mongodb || req.sql || req.database) return false;
  const mode = req.body?.mode;
  if (mode === 'graphql' || req.body?.soap) return false;
  return HTTP_METHODS.has(String(req.method ?? '').toUpperCase());
}

/** Id of the folder that directly contains `itemId` (null for the collection root, undefined if absent). */
export function findParentFolderId(items: CollectionItem[], itemId: string, parentId: string | null = null): string | null | undefined {
  for (const it of items) {
    if (it.id === itemId) return parentId;
    if (it.item) {
      const found = findParentFolderId(it.item, itemId, it.id ?? null);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findFolderItems(items: CollectionItem[], folderId: string): CollectionItem[] | undefined {
  for (const it of items) {
    if (it.id === folderId && it.item) return it.item;
    if (it.item) {
      const found = findFolderItems(it.item, folderId);
      if (found) return found;
    }
  }
  return undefined;
}

/** A neighbour as sent to the server: the request and its scripts, without saved examples or children. */
function stripNeighbor(item: CollectionItem): CollectionItem {
  return { id: item.id, name: item.name, request: item.request, ...(item.event ? { event: item.event } : {}) };
}

/**
 * Up to 5 HTTP requests from a folder (or the collection root when `folderId` is null) to serve as
 * style examples: direct children first, then deeper descendants.
 */
export function collectNeighbors(collectionItems: CollectionItem[], folderId: string | null, excludeId?: string, limit = MAX_NEIGHBORS): CollectionItem[] {
  const scope = folderId ? findFolderItems(collectionItems, folderId) ?? [] : collectionItems;
  const out: CollectionItem[] = [];
  const queue: CollectionItem[][] = [scope];
  while (queue.length && out.length < limit) {
    const level = queue.shift()!;
    for (const it of level) {
      if (out.length >= limit) break;
      if (it.id !== excludeId && isHttpRestItem(it)) out.push(stripNeighbor(it));
    }
    for (const it of level) if (it.item) queue.push(it.item);
  }
  return out;
}

export interface VariableMeta { name: string; scope: 'environment' | 'global' | 'collection'; secret: boolean }

/** Names of the variables a request can use. Values are never read into the result. */
export function collectVariableMeta(args: {
  environments: AppEnvironment[];
  activeEnvironmentId: string | null;
  globalVariables: Record<string, string>;
  globalVariableMeta?: Record<string, GlobalVariableMeta>;
  collectionVariables?: Record<string, string>;
  collection?: Pick<AppCollection, 'variable'>;
}): VariableMeta[] {
  const out: VariableMeta[] = [];
  const seen = new Set<string>();
  const add = (name: string, scope: VariableMeta['scope'], secret: boolean) => {
    const key = `${scope}:${name}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push({ name, scope, secret });
  };
  const env = args.environments.find(e => e._id === args.activeEnvironmentId);
  for (const v of env?.values ?? []) if (v.enabled !== false && v.key) add(v.key, 'environment', v.secret === true);
  for (const k of Object.keys(args.globalVariables ?? {})) add(k, 'global', args.globalVariableMeta?.[k]?.secret === true);
  for (const k of Object.keys(args.collectionVariables ?? {})) add(k, 'collection', false);
  for (const v of args.collection?.variable ?? []) if (!v.disabled && v.key) add(v.key, 'collection', false);
  return out.slice(0, 1000);
}
