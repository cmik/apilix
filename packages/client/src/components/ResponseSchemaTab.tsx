import { useEffect, useState } from 'react';
import { useApp, generateId } from '../store';
import type { CollectionItem, RequestResponse, ResponseSchema, ResponseSchemaLink, SchemaRunMode } from '../types';
import { inferSchema, validateSchema } from '../api';
import { getSchemaLinks, isValidLinkMatch, resolveSchemaLink, toSchemaRegistry } from '../utils/responseSchemas';
import SchemaEditorModal from './SchemaEditorModal';
import type { SchemaEditorSave } from './SchemaEditorModal';
import ConfirmModal from './ConfirmModal';

interface ResponseSchemaTabProps {
  collectionId: string;
  item: CollectionItem;
  response: RequestResponse | null;
}

const MATCH_PRESETS = ['200', '2xx', '4xx', '5xx', 'default'];

function isJsonBody(response: RequestResponse | null): response is RequestResponse {
  if (!response || response.error || response.bodyBase64 || !response.body) return false;
  try { JSON.parse(response.body); return true; } catch { return false; }
}

/**
 * Status match field. Keeps its own draft and only saves a valid value (exact status like 200, Nxx like 4xx, or
 * default); an invalid draft is flagged with an explicit message and never reaches the store.
 */
function MatchInput({ value, onValid }: { value: string; onValid: (match: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const trimmed = draft.trim();
  const valid = isValidLinkMatch(trimmed);
  return (
    <div className="flex flex-col">
      <input
        list="schema-match-presets"
        aria-label="Status match"
        aria-invalid={!valid}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
          const t = e.target.value.trim();
          if (isValidLinkMatch(t)) onValid(t);
        }}
        className={`w-24 bg-slate-700 border rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-orange-500 ${valid ? 'border-slate-600' : 'border-red-500'}`}
      />
      {!valid && (
        <span role="alert" className="text-[10px] text-red-400 mt-0.5 max-w-[12rem]">
          Invalid match, not saved: use a status code (200), a class (4xx) or default.
        </span>
      )}
    </div>
  );
}

/** Request tab: link response schemas to status codes and create them from the last response. */
export default function ResponseSchemaTab({ collectionId, item, response }: ResponseSchemaTabProps) {
  const { state, dispatch } = useApp();
  const schemas = state.responseSchemas;
  const requestId = item.id ?? '';
  const links = getSchemaLinks(item);
  const canLink = !!collectionId && !!requestId;

  const [editor, setEditor] = useState<{ initial: ResponseSchema | null; draft: Record<string, unknown> | null; name: string; linkStatus?: string } | null>(null);
  const [deleting, setDeleting] = useState<ResponseSchema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setLinks = (next: ResponseSchemaLink[]) => {
    if (!canLink) return;
    dispatch({ type: 'REQUEST_SET_SCHEMA_LINKS', payload: { collectionId, requestId, links: next } });
  };

  const jsonReady = isJsonBody(response);

  async function startInfer() {
    if (!response || !jsonReady) return;
    setBusy(true); setError(null);
    try {
      const draft = await inferSchema({ bodies: [response.body] }, { formats: true });
      setEditor({ initial: null, draft, name: `${item.name} ${response.status}`.trim(), linkStatus: String(response.status) });
    } catch (e) {
      setError(`Could not infer a schema: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  function handleSave(value: SchemaEditorSave) {
    if (!editor) return;
    if (editor.initial) {
      dispatch({ type: 'SCHEMA_UPDATE', payload: { id: editor.initial.id, patch: { name: value.name, description: value.description, schema: value.schema } } });
    } else {
      const id = generateId();
      dispatch({ type: 'SCHEMA_ADD', payload: { id, name: value.name, description: value.description || undefined, schema: value.schema, version: 1, source: editor.draft ? 'inferred' : 'manual' } });
      if (editor.linkStatus && canLink && !links.some(l => l.match === editor.linkStatus)) {
        setLinks([...links, { schemaId: id, match: editor.linkStatus }]);
      }
    }
    setEditor(null);
  }

  const updateLink = (idx: number, patch: Partial<ResponseSchemaLink>) => setLinks(links.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-slate-500">
        Link a JSON Schema to the response status codes of this request. A runner or CLI run validates each response against the
        schema that matches its status (exact code, then <code className="text-orange-400">2xx</code>, then <code className="text-orange-400">default</code>).
      </p>

      {!canLink && <p className="text-xs text-amber-400">Save this request in a collection to link schemas to it.</p>}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-slate-300">Linked schemas</h4>
          <button
            onClick={() => schemas.length > 0 && setLinks([...links, { schemaId: schemas[0].id, match: links.some(l => l.match === '200') ? 'default' : '200' }])}
            disabled={!canLink || schemas.length === 0}
            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Add link
          </button>
        </div>
        {links.length === 0 && <p className="text-xs text-slate-500">{schemas.length === 0 ? 'No schema yet: create one below.' : 'No schema linked.'}</p>}
        {links.map((l, i) => {
          const missing = !schemas.some(s => s.id === l.schemaId);
          return (
            <div key={i} className="flex items-center gap-2" data-testid="schema-link-row">
              <MatchInput value={String(l.match)} onValid={match => updateLink(i, { match })} />
              <select
                aria-label="Schema"
                value={missing ? '' : l.schemaId}
                onChange={e => updateLink(i, { schemaId: e.target.value })}
                className="flex-1 min-w-0 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-orange-500"
              >
                {missing && <option value="">(missing schema)</option>}
                {schemas.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select
                aria-label="Mode"
                value={l.mode ?? ''}
                onChange={e => updateLink(i, { mode: (e.target.value || undefined) as SchemaRunMode | undefined })}
                title="This link's own mode, capped by the run-level setting (a run set to warn downgrades strict; a run set to off disables all)"
                className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-orange-500"
              >
                <option value="">Run mode</option>
                <option value="off">Off</option>
                <option value="warn">Warn</option>
                <option value="strict">Strict</option>
              </select>
              <button onClick={() => setLinks(links.filter((_, j) => j !== i))} aria-label="Remove link" className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors">
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
              </button>
            </div>
          );
        })}
        <datalist id="schema-match-presets">{MATCH_PRESETS.map(p => <option key={p} value={p} />)}</datalist>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-slate-300">Schemas in this workspace</h4>
          <div className="flex gap-2">
            <button
              onClick={startInfer}
              disabled={!jsonReady || busy}
              title={jsonReady ? 'Infer a schema from the last response' : 'Send the request first: a JSON response is needed'}
              className="px-2 py-1 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Infer from last response
            </button>
            <button
              onClick={() => setEditor({ initial: null, draft: { type: 'object', properties: {} }, name: '' })}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors"
            >
              New schema
            </button>
          </div>
        </div>
        {error && <span className="text-xs text-red-400">{error}</span>}
        {schemas.length === 0 && <p className="text-xs text-slate-500">No schema yet.</p>}
        {schemas.map(s => (
          <div key={s.id} className="flex items-center gap-2 text-xs bg-slate-800 border border-slate-700 rounded px-2 py-1.5" data-testid="schema-row">
            <span className="text-slate-200 font-medium truncate">{s.name}</span>
            <span className="text-slate-500 font-mono">v{s.version}</span>
            {s.source === 'inferred' && <span className="text-[10px] px-1 rounded bg-slate-700 text-slate-400 border border-slate-600">inferred</span>}
            <span className="ml-auto flex gap-1">
              <button onClick={() => setEditor({ initial: s, draft: null, name: s.name })} className="px-2 py-0.5 text-orange-400 hover:text-orange-300">Edit</button>
              <button onClick={() => setDeleting(s)} className="px-2 py-0.5 text-slate-400 hover:text-red-400">Delete</button>
            </span>
          </div>
        ))}
      </div>

      {editor && (
        <SchemaEditorModal
          initial={editor.initial}
          draftSchema={editor.draft}
          suggestedName={editor.name}
          existing={schemas}
          sampleBody={jsonReady ? response!.body : null}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete schema"
          message={<>Delete <strong>{deleting.name}</strong>? Links to it are removed from every request. Scripts using <code>matchSchema(&quot;{deleting.name}&quot;)</code> will fail.</>}
          confirmLabel="Delete"
          onConfirm={() => { dispatch({ type: 'SCHEMA_DELETE', payload: deleting.id }); setDeleting(null); }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** Status-bar badge: result of the response against the schema linked to its status code. */
export function SchemaBadge({ response }: { response: RequestResponse }) {
  const { state } = useApp();
  const allSchemas = state.responseSchemas ?? [];
  const links = getSchemaLinks(state.activeRequest?.item);
  const link = resolveSchemaLink(links, response.status);
  const schema = link ? allSchemas.find(s => s.id === link.schemaId) : undefined;
  const [outcome, setOutcome] = useState<{ state: 'ok' | 'bad' | 'error' | 'empty'; count?: number; detail?: string } | null>(null);
  const body = response.body;
  const registrySig = JSON.stringify(toSchemaRegistry(allSchemas));

  useEffect(() => {
    if (!schema || state.schemaRunMode === 'off' || link?.mode === 'off' || response.error || response.bodyBase64) { setOutcome(null); return; }
    // Same as the runner: an empty/whitespace body (204...) is skipped, never a violation.
    if (typeof body !== 'string' || body.trim() === '') { setOutcome({ state: 'empty', detail: 'empty body, nothing to validate' }); return; }
    let cancelled = false;
    validateSchema({ schema: schema.schema, body, schemas: JSON.parse(registrySig), allErrors: true })
      .then(r => {
        if (cancelled) return;
        if (r.schemaError) setOutcome({ state: 'error', detail: r.schemaError });
        else if (r.valid) setOutcome({ state: 'ok' });
        else setOutcome({ state: 'bad', count: r.errors.length, detail: r.errors.slice(0, 5).map(e => `${e.path || '(root)'} ${e.message}`).join('\n') });
      })
      .catch(() => { if (!cancelled) setOutcome(null); });
    return () => { cancelled = true; };
  }, [schema, body, registrySig, state.schemaRunMode, link?.mode, response.error, response.bodyBase64]);

  if (!schema || !outcome) return null;
  if (outcome.state === 'empty') {
    return <span data-testid="schema-badge" title={outcome.detail} className="text-xs px-2 py-0.5 rounded font-medium bg-slate-700 text-slate-300">{`Schema ${schema.name}: skipped (empty body)`}</span>;
  }
  const cls = outcome.state === 'ok' ? 'bg-green-800 text-green-200' : outcome.state === 'bad' ? 'bg-amber-800 text-amber-200' : 'bg-red-800 text-red-200';
  const label = outcome.state === 'ok' ? `Schema ${schema.name}: matches` : outcome.state === 'bad' ? `Schema ${schema.name}: ${outcome.count} violation${outcome.count === 1 ? '' : 's'}` : `Schema ${schema.name}: invalid`;
  return (
    <span data-testid="schema-badge" title={outcome.detail} className={`text-xs px-2 py-0.5 rounded font-medium ${cls}`}>{label}</span>
  );
}
