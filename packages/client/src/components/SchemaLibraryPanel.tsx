import { useMemo, useRef, useState } from 'react';
import { useApp, generateId } from '../store';
import type { ResponseSchema } from '../types';
import {
  buildSchemaExport, duplicateSchema, findSchemaReferrers, findSchemaUsage, mergeImportedSchemas,
  parseSchemaImport, validateSchemaName,
} from '../utils/responseSchemas';
import SchemaEditorModal from './SchemaEditorModal';
import type { SchemaEditorSave } from './SchemaEditorModal';
import ConfirmModal from './ConfirmModal';

const btn = 'px-2 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
const btnPrimary = 'px-2 py-1 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

function download(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Workspace schema library: list, search, create, rename, duplicate, delete, edit, history, usage, import/export. */
export default function SchemaLibraryPanel() {
  const { state, dispatch } = useApp();
  const schemas = state.responseSchemas ?? [];
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ initial: ResponseSchema | null } | null>(null);
  const [deleting, setDeleting] = useState<ResponseSchema | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? schemas.filter(s => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)) : schemas;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [schemas, query]);

  const selected = schemas.find(s => s.id === selectedId) ?? null;
  const usage = useMemo(() => (selected ? findSchemaUsage(state.collections, selected.id) : []), [state.collections, selected]);
  const referrers = useMemo(() => (selected ? findSchemaReferrers(schemas, selected) : []), [schemas, selected]);
  const deletingUsage = useMemo(() => (deleting ? findSchemaUsage(state.collections, deleting.id) : []), [state.collections, deleting]);
  const usageCount = (id: string) => findSchemaUsage(state.collections, id).length;

  function handleSave(value: SchemaEditorSave) {
    if (!editor) return;
    if (editor.initial) {
      dispatch({ type: 'SCHEMA_UPDATE', payload: { id: editor.initial.id, patch: { name: value.name, description: value.description, schema: value.schema } } });
    } else {
      const id = generateId();
      dispatch({ type: 'SCHEMA_ADD', payload: { id, name: value.name, description: value.description || undefined, schema: value.schema, version: 1, source: 'manual' } });
      setSelectedId(id);
    }
    setEditor(null);
  }

  function commitRename() {
    if (!renaming) return;
    const current = schemas.find(s => s.id === renaming.id);
    if (!current) { setRenaming(null); return; }
    if (renaming.value.trim() === current.name) { setRenaming(null); return; }
    if (validateSchemaName(schemas, renaming.value, current.id)) return;
    dispatch({ type: 'SCHEMA_UPDATE', payload: { id: current.id, patch: { name: renaming.value.trim() } } });
    setRenaming(null);
  }

  function handleDuplicate(s: ResponseSchema) {
    const copy = duplicateSchema(schemas, s, generateId());
    dispatch({ type: 'SCHEMA_ADD', payload: copy });
    setSelectedId(copy.id);
  }

  function restoreVersion(s: ResponseSchema, schema: Record<string, unknown>) {
    dispatch({ type: 'SCHEMA_UPDATE', payload: { id: s.id, patch: { schema } } });
  }

  async function handleImport(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const parsed = parseSchemaImport(await file.text(), file.name, generateId);
      if ('error' in parsed) { setNotice({ kind: 'error', text: parsed.error }); return; }
      const res = mergeImportedSchemas(schemas, parsed.schemas);
      dispatch({ type: 'SCHEMA_SET_ALL', payload: res.schemas });
      const skipped = res.skipped;
      setNotice({
        kind: 'ok',
        text: `Imported ${res.added} schema${res.added === 1 ? '' : 's'}${res.renamed ? ` (${res.renamed} renamed to keep names unique)` : ''}${skipped ? `, ${skipped} skipped (already in the library)` : ''}.`,
      });
    } catch (e) {
      setNotice({ kind: 'error', text: `Import failed: ${(e as Error).message}` });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const renameError = renaming ? validateSchemaName(schemas, renaming.value, renaming.id) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-950" data-testid="schema-library">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-700 bg-slate-900 shrink-0">
        <h2 className="text-sm font-semibold text-slate-200 mr-2">Schema library</h2>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search schemas"
          aria-label="Search schemas"
          className="w-56 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-orange-500"
        />
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => fileRef.current?.click()} className={btn}>Import</button>
          <button onClick={() => download('apilix-schemas.json', buildSchemaExport(schemas))} disabled={schemas.length === 0} className={btn}>Export all</button>
          <button onClick={() => setEditor({ initial: null })} className={btnPrimary}>+ New schema</button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" data-testid="schema-import-input" onChange={e => { void handleImport(e.target.files); }} />
        </div>
      </div>
      {notice && (
        <div className={`px-4 py-1.5 text-xs border-b border-slate-700 ${notice.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`} role="status">{notice.text}</div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="w-80 shrink-0 border-r border-slate-700 overflow-y-auto">
          {schemas.length === 0 && <p className="p-4 text-xs text-slate-500">No schema yet. Create one, import a file, or infer one from a response.</p>}
          {schemas.length > 0 && filtered.length === 0 && <p className="p-4 text-xs text-slate-500">No schema matches &quot;{query}&quot;.</p>}
          {filtered.map(s => {
            const n = usageCount(s.id);
            return (
              <button
                key={s.id}
                data-testid="library-row"
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left px-3 py-2 border-b border-slate-800 transition-colors ${s.id === selectedId ? 'bg-slate-800' : 'hover:bg-slate-900'}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-200 font-medium truncate">{s.name}</span>
                  <span className="text-[10px] text-slate-500 font-mono">v{s.version}</span>
                  {s.source === 'inferred' && <span className="text-[10px] px-1 rounded bg-slate-700 text-slate-400 border border-slate-600">inferred</span>}
                  <span className="ml-auto text-[10px] text-slate-500">{n} request{n === 1 ? '' : 's'}</span>
                </div>
                {s.description && <div className="text-[11px] text-slate-500 truncate mt-0.5">{s.description}</div>}
              </button>
            );
          })}
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto p-4">
          {!selected && <p className="text-xs text-slate-500">Select a schema to see its details.</p>}
          {selected && (
            <div className="flex flex-col gap-4" data-testid="library-detail">
              <div className="flex items-center gap-2 flex-wrap">
                {renaming && renaming.id === selected.id ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        aria-label="New schema name"
                        value={renaming.value}
                        onChange={e => setRenaming({ id: selected.id, value: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }}
                        className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                      />
                      <button onClick={commitRename} disabled={!!renameError && renaming.value.trim() !== selected.name} className={btnPrimary}>Save</button>
                      <button onClick={() => setRenaming(null)} className={btn}>Cancel</button>
                    </div>
                    {renameError && renaming.value.trim() !== selected.name && <span className="text-xs text-red-400">{renameError}</span>}
                    {(usage.length > 0 || referrers.length > 0) && (
                      <span className="text-[11px] text-amber-400">Scripts using matchSchema(&quot;{selected.name}&quot;) and {`{ "$ref": "${selected.name}" }`} in other schemas are not renamed automatically.</span>
                    )}
                  </div>
                ) : (
                  <h3 className="text-base font-semibold text-slate-100">{selected.name}</h3>
                )}
                <span className="text-xs text-slate-500 font-mono">v{selected.version}</span>
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={() => setEditor({ initial: selected })} className={btnPrimary}>Edit</button>
                  <button onClick={() => setRenaming({ id: selected.id, value: selected.name })} className={btn}>Rename</button>
                  <button onClick={() => handleDuplicate(selected)} className={btn}>Duplicate</button>
                  <button onClick={() => download(`${selected.name.replace(/[^\w.-]+/g, '_') || 'schema'}.schema.json`, buildSchemaExport([selected]))} className={btn}>Export</button>
                  <button onClick={() => setDeleting(selected)} className={`${btn} hover:!text-red-400`}>Delete</button>
                </div>
              </div>
              {selected.description && <p className="text-xs text-slate-400">{selected.description}</p>}

              <section>
                <h4 className="text-xs font-semibold text-slate-300 mb-1">Used by ({usage.length} request{usage.length === 1 ? '' : 's'})</h4>
                {usage.length === 0 && <p className="text-xs text-slate-500">No request links to this schema.</p>}
                <ul className="flex flex-col gap-1">
                  {usage.map(u => (
                    <li key={`${u.requestId}-${u.match}`} className="flex items-center gap-2 text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1" data-testid="used-by-row">
                      <span className="text-slate-500 truncate">{u.collectionName}</span>
                      <span className="text-slate-600">/</span>
                      <span className="text-slate-200 truncate">{u.requestName}</span>
                      <span className="text-[10px] font-mono px-1 rounded bg-slate-700 text-slate-300 border border-slate-600">{u.match}</span>
                      <button
                        onClick={() => {
                          const col = state.collections.find(c => c._id === u.collectionId);
                          const find = (items: typeof state.collections[number]['item']): (typeof state.collections[number]['item'][number]) | undefined => {
                            for (const it of items) { if (it.id === u.requestId) return it; const f = it.item ? find(it.item) : undefined; if (f) return f; }
                            return undefined;
                          };
                          const item = col ? find(col.item) : undefined;
                          if (item) {
                            dispatch({ type: 'OPEN_TAB', payload: { collectionId: u.collectionId, item } });
                            dispatch({ type: 'SET_VIEW', payload: 'request' });
                          }
                        }}
                        className="ml-auto text-orange-400 hover:text-orange-300 underline underline-offset-2"
                      >
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
                {referrers.length > 0 && (
                  <p className="text-xs text-slate-500 mt-2">Referenced with $ref by: {referrers.map(r => r.name).join(', ')}</p>
                )}
              </section>

              <section>
                <h4 className="text-xs font-semibold text-slate-300 mb-1">Version history</h4>
                <ul className="flex flex-col gap-1">
                  <li className="flex items-center gap-2 text-xs text-slate-400" data-testid="history-row">
                    <span className="font-mono text-slate-200">v{selected.version}</span>
                    <span className="text-slate-500">{selected.updatedAt ?? ''}</span>
                    <span className="ml-auto text-[10px] text-slate-500">current</span>
                  </li>
                  {(selected.history ?? []).map(h => (
                    <li key={h.version} className="flex items-center gap-2 text-xs text-slate-400" data-testid="history-row">
                      <span className="font-mono text-slate-300">v{h.version}</span>
                      <span className="text-slate-500">{h.updatedAt}</span>
                      <button onClick={() => restoreVersion(selected, h.schema)} className="ml-auto text-orange-400 hover:text-orange-300 underline underline-offset-2">Restore as new version</button>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-slate-300 mb-1">JSON Schema</h4>
                <pre className="bg-slate-900 border border-slate-700 rounded p-3 text-xs font-mono text-slate-200 overflow-auto max-h-96">{JSON.stringify(selected.schema, null, 2)}</pre>
              </section>
            </div>
          )}
        </div>
      </div>

      {editor && (
        <SchemaEditorModal
          initial={editor.initial}
          draftSchema={editor.initial ? null : { type: 'object', properties: {} }}
          existing={schemas}
          sampleBody={null}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete schema"
          message={
            <div className="space-y-2">
              <p>Delete <strong>{deleting.name}</strong>? Its links are removed from every request. Scripts using <code>matchSchema(&quot;{deleting.name}&quot;)</code> will fail.</p>
              {deletingUsage.length > 0 ? (
                <div>
                  <p className="text-slate-300">Linked requests ({deletingUsage.length}):</p>
                  <ul className="list-disc pl-4 max-h-32 overflow-y-auto" data-testid="delete-usage">
                    {deletingUsage.map(u => <li key={`${u.requestId}-${u.match}`}>{u.collectionName} / {u.requestName} ({u.match})</li>)}
                  </ul>
                </div>
              ) : <p>No request links to it.</p>}
            </div>
          }
          confirmLabel="Delete"
          onConfirm={() => {
            dispatch({ type: 'SCHEMA_DELETE', payload: deleting.id });
            if (selectedId === deleting.id) setSelectedId(null);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
