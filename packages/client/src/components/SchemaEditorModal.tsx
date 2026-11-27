import { useEffect, useMemo, useState } from 'react';
import type { ResponseSchema, SchemaInferenceOptions, SchemaValidationResult } from '../types';
import { inferSchema, validateSchema } from '../api';
import { findIgnoredKeywords, toSchemaRegistry, validateSchemaName } from '../utils/responseSchemas';

export interface SchemaEditorSave {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

interface SchemaEditorModalProps {
  /** Existing schema when editing; null/undefined when creating. */
  initial?: ResponseSchema | null;
  /** Schema proposed for a new entry (e.g. inferred from a response). */
  draftSchema?: Record<string, unknown> | null;
  suggestedName?: string;
  /** All schemas of the workspace (name uniqueness, $ref registry). */
  existing: ResponseSchema[];
  /** Last response body, to re-infer with other options and to test the schema against. */
  sampleBody?: string | null;
  onSave: (value: SchemaEditorSave) => void;
  onClose: () => void;
}

function pretty(obj: unknown): string {
  return JSON.stringify(obj ?? { type: 'object' }, null, 2);
}

export default function SchemaEditorModal({ initial, draftSchema, suggestedName, existing, sampleBody, onSave, onClose }: SchemaEditorModalProps) {
  const [name, setName] = useState(initial?.name ?? suggestedName ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [text, setText] = useState(pretty(initial?.schema ?? draftSchema));
  const [opts, setOpts] = useState<SchemaInferenceOptions>({ enums: false, bounds: false, formats: true, requiredThreshold: 1 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SchemaValidationResult | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nameError = validateSchemaName(existing, name, initial?.id);
  const parsed = useMemo<{ value?: Record<string, unknown>; error?: string }>(() => {
    try {
      const v = JSON.parse(text);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'The schema must be a JSON object' };
      return { value: v as Record<string, unknown> };
    } catch (e) {
      return { error: `Invalid JSON: ${(e as Error).message}` };
    }
  }, [text]);

  async function reinfer() {
    if (!sampleBody) return;
    setBusy(true); setMessage(null);
    try {
      const schema = await inferSchema({ bodies: [sampleBody] }, opts);
      setText(pretty(schema));
      setTestResult(null);
    } catch (e) {
      setMessage(`Inference failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  async function runTest() {
    if (!sampleBody || !parsed.value) return;
    setBusy(true); setMessage(null);
    try {
      const registry = toSchemaRegistry(existing.filter(s => s.id !== initial?.id));
      setTestResult(await validateSchema({ schema: parsed.value, body: sampleBody, schemas: registry, allErrors: true }));
    } catch (e) {
      setMessage(`Validation failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  const ignoredKeywords = useMemo(() => (parsed.value ? findIgnoredKeywords(parsed.value) : []), [parsed.value]);
  const canSave = !nameError && !!parsed.value;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div role="dialog" aria-label={initial ? 'Edit schema' : 'New schema'} className="fixed z-50 top-[8%] left-1/2 -translate-x-1/2 w-[720px] max-w-[95vw] max-h-[84vh] flex flex-col bg-slate-900 border border-slate-700 rounded-lg shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <h3 className="text-sm font-semibold text-slate-200">
            {initial ? `Edit schema (v${initial.version})` : 'New response schema'}
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors">
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3 overflow-y-auto min-h-0">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="schema-name" className="text-xs text-slate-400">Name</label>
              <input
                id="schema-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. User"
                className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
              />
              {name !== '' && nameError && <span className="text-xs text-red-400">{nameError}</span>}
              <span className="text-[11px] text-slate-500">Used in scripts: <code className="text-orange-400">apx.expect(data).to.matchSchema(&quot;{name || 'Name'}&quot;)</code></span>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="schema-desc" className="text-xs text-slate-400">Description</label>
              <input
                id="schema-desc"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
              />
            </div>
          </div>

          {sampleBody && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 bg-slate-800 border border-slate-700 rounded px-3 py-2">
              <span className="text-slate-300 font-medium">Infer from last response</span>
              <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-orange-500" checked={!!opts.enums} onChange={e => setOpts(o => ({ ...o, enums: e.target.checked }))} />Enums</label>
              <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-orange-500" checked={!!opts.bounds} onChange={e => setOpts(o => ({ ...o, bounds: e.target.checked }))} />Bounds</label>
              <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-orange-500" checked={opts.formats !== false} onChange={e => setOpts(o => ({ ...o, formats: e.target.checked }))} />Formats</label>
              <button onClick={reinfer} disabled={busy} className="ml-auto px-3 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                Re-infer
              </button>
              <span className="basis-full text-[11px] text-slate-500">Enums and bounds copy values seen in the response; they are never emitted for ids, tokens, dates or secret-looking fields.</span>
            </div>
          )}

          <div className="flex flex-col gap-1 min-h-0">
            <label htmlFor="schema-json" className="text-xs text-slate-400">JSON Schema</label>
            <textarea
              id="schema-json"
              value={text}
              onChange={e => { setText(e.target.value); setTestResult(null); }}
              spellCheck={false}
              rows={16}
              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500 resize-y"
            />
            {parsed.error && <span className="text-xs text-red-400">{parsed.error}</span>}
            {ignoredKeywords.length > 0 && (
              <span className="text-[11px] text-amber-400" data-testid="schema-ignored-keywords">
                Note: {ignoredKeywords.join(', ')} {ignoredKeywords.length === 1 ? 'is a' : 'are'} JSON Schema 2019/2020 keyword{ignoredKeywords.length === 1 ? '' : 's'} that this draft-07 validator ignores, so {ignoredKeywords.length === 1 ? 'it does' : 'they do'} not constrain responses.
              </span>
            )}
            <span className="text-[11px] text-slate-500">Reference another schema by name with <code className="text-orange-400">{'{ "$ref": "OtherName" }'}</code>.</span>
          </div>

          {initial && initial.history && initial.history.length > 0 && (
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer select-none">History ({initial.history.length})</summary>
              <ul className="mt-1 flex flex-col gap-1">
                {initial.history.map(h => (
                  <li key={h.version} className="flex items-center gap-2">
                    <span className="font-mono text-slate-300">v{h.version}</span>
                    <span className="text-slate-500">{h.updatedAt}</span>
                    <button onClick={() => { setText(pretty(h.schema)); setTestResult(null); }} className="ml-auto text-orange-400 hover:text-orange-300 underline underline-offset-2">Load into editor</button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {sampleBody && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <button onClick={runTest} disabled={busy || !parsed.value} className="px-3 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                  Test against last response
                </button>
                {testResult && (testResult.schemaError
                  ? <span className="text-xs text-red-400">Invalid schema: {testResult.schemaError}</span>
                  : testResult.valid
                    ? <span className="text-xs text-green-400">Matches</span>
                    : <span className="text-xs text-red-400">{testResult.errors.length}{testResult.truncated ? '+' : ''} violation(s)</span>)}
              </div>
              {testResult && !testResult.valid && !testResult.schemaError && (
                <ul className="text-xs font-mono text-red-300 flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                  {testResult.errors.map((e, i) => <li key={i}>{e.path || '(root)'} {e.message}</li>)}
                </ul>
              )}
            </div>
          )}
          {message && <span className="text-xs text-red-400">{message}</span>}
        </div>

        <div className="px-4 py-3 border-t border-slate-700 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors">Cancel</button>
          <button
            onClick={() => parsed.value && onSave({ name: name.trim(), description: description.trim(), schema: parsed.value })}
            disabled={!canSave}
            className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>
    </>
  );
}
