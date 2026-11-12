import { buildDocModel, neutralizeAiText } from '@apilix/core/docs';
import type { AppCollection, DocAiDescription } from '../types';

/** One reviewable AI suggestion: a request, a folder, or the collection itself. */
export interface AiDescriptionRow {
  id: string;
  kind: 'collection' | 'folder' | 'request';
  /** Human label ("Folder / Request"). */
  label: string;
  included: boolean;
  description: string;
  params: Record<string, string>;
}

const COLLECTION_KEY = '__collection__';

/**
 * Turn the server's `{ id → description }` answer into rows the user can review and edit.
 * Labels come from the same doc model the export uses, so ids always line up.
 */
export function buildAiRows(
  collection: AppCollection,
  folderId: string | undefined,
  descriptions: Record<string, DocAiDescription>,
): AiDescriptionRow[] {
  const model = buildDocModel(collection as never, { folder: folderId });
  const rows: AiDescriptionRow[] = [];
  const push = (id: string, kind: AiDescriptionRow['kind'], label: string) => {
    const d = Object.prototype.hasOwnProperty.call(descriptions, id) ? descriptions[id] : undefined;
    if (!d || (!d.description && !(d.params && Object.keys(d.params).length))) return;
    rows.push({ id, kind, label, included: true, description: d.description ?? '', params: { ...(d.params ?? {}) } });
  };
  push(COLLECTION_KEY, 'collection', `${model.title} (collection)`);
  const walk = (nodes: typeof model.tree, trail: string[]) => {
    for (const n of nodes) {
      if (n.type === 'folder') {
        push(n.id, 'folder', [...trail, n.name].join(' / '));
        walk(n.children ?? [], [...trail, n.name]);
      }
    }
  };
  walk(model.tree, []);
  for (const r of model.requests) push(r.id, 'request', [...r.folderPath, `${r.method} ${r.name}`].join(' / '));
  return rows;
}

/** Descriptions to feed back into the export: included rows only, blanks dropped. */
export function rowsToDescriptions(rows: AiDescriptionRow[]): Record<string, DocAiDescription> {
  const out: Record<string, DocAiDescription> = {};
  for (const row of rows) {
    if (!row.included) continue;
    // Edited text is flattened too: a pasted link or image must not reach the exported document.
    const description = neutralizeAiText(row.description);
    const params = Object.fromEntries(Object.entries(row.params).map(([k, v]) => [k, neutralizeAiText(v)]).filter(([, v]) => v));
    if (!description && !Object.keys(params).length) continue;
    out[row.id] = { ...(description ? { description } : {}), ...(Object.keys(params).length ? { params } : {}) };
  }
  return out;
}
