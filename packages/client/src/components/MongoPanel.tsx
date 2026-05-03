import { useState, useEffect, useCallback, useRef } from 'react';
import type { VariableSuggestion } from '../utils/variableAutocomplete';
import VarInput from './VarInput';
import CodeEditor from './CodeEditor';
import MongoPipelineSnippets from './MongoPipelineSnippets';
import { listMongoDatabases, listMongoCollections, type MongoAuthOverride } from '../api';

// ─── Types ───────────────────────────────────────────────────────────────────

type ConnectionMode = 'direct' | 'named';
type Operation = 'find' | 'aggregate' | 'insert' | 'update' | 'delete' | 'count' | 'distinct' | 'script';

interface MongoConfig {
  connection?: {
    mode: ConnectionMode;
    uri?: string;
    connectionId?: string;
  };
  database?: string;
  collection?: string;
  operation?: Operation;
  filter?: string;
  projection?: string;
  sort?: string;
  skip?: number;
  limit?: number;
  pipeline?: string;
  documents?: string;
  update?: string;
  updateMode?: 'one' | 'many';
  deleteMode?: 'one' | 'many';
  distinctField?: string;
  script?: string;
  useTransaction?: boolean;
  maxTimeMS?: number;
  auth?: {
    mode?: string;
    username?: string;
    password?: string;
    authSource?: string;
  };
}

const DEFAULT_CONFIG: MongoConfig = {
  connection: { mode: 'direct', uri: '{{mongoUri}}' },
  database: '{{mongoDb}}',
  collection: '',
  operation: 'find',
  filter: '{}',
  limit: 50,
};

const OPERATIONS: { value: Operation; label: string; description: string }[] = [
  { value: 'find',      label: 'Find',      description: 'Query documents' },
  { value: 'aggregate', label: 'Aggregate', description: 'Run a pipeline' },
  { value: 'insert',    label: 'Insert',    description: 'Insert documents' },
  { value: 'update',    label: 'Update',    description: 'Update documents' },
  { value: 'delete',    label: 'Delete',    description: 'Delete documents' },
  { value: 'count',     label: 'Count',     description: 'Count documents' },
  { value: 'distinct',  label: 'Distinct',  description: 'Get distinct values' },
  { value: 'script',    label: 'Script',    description: 'Run custom JS' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function parseMongoConfig(raw: string): MongoConfig | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as MongoConfig) : null;
  } catch {
    return null;
  }
}

function serialize(cfg: MongoConfig): string {
  return JSON.stringify(cfg, null, 2);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface JsonTextareaProps {
  label?: string;
  labelNode?: React.ReactNode;
  value: string;
  placeholder?: string;
  rows?: number;
  hint?: string;
  noValidate?: boolean;
  onChange: (v: string) => void;
  variableSuggestions?: VariableSuggestion[];
}

function JsonTextarea({ label, labelNode, value, placeholder, rows = 3, hint, noValidate, onChange, variableSuggestions }: JsonTextareaProps) {
  const [invalid, setInvalid] = useState(false);

  function handleChange(v: string) {
    onChange(v);
    if (noValidate || !v.trim()) { setInvalid(false); return; }
    try { JSON.parse(v); setInvalid(false); } catch { setInvalid(true); }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        {labelNode ?? <span className="text-xs text-slate-400">{label}</span>}
        <div className="flex items-center gap-2">
          {hint && <span className="text-[10px] text-slate-600 italic">{hint}</span>}
          {invalid && <span className="text-[10px] text-red-400">Invalid JSON</span>}
        </div>
      </div>
      <CodeEditor
        value={value}
        language="json"
        onChange={e => handleChange((e.target as HTMLTextAreaElement).value)}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        variableSuggestions={variableSuggestions}
        className={`w-full bg-slate-700 border rounded text-xs font-mono text-slate-200 focus:outline-none resize-y ${
          invalid ? 'border-red-500' : 'border-slate-600 focus:border-orange-500'
        }`}
      />
    </div>
  );
}

// ─── FetchPicker – a button + dropdown for database or collection names ───────

interface FetchPickerProps {
  onSelect: (value: string) => void;
  fetchItems: () => Promise<string[]>;
  disabled?: boolean;
  title?: string;
}

function FetchPicker({ onSelect, fetchItems, disabled, title = 'Fetch list' }: FetchPickerProps) {
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function handleOpen() {
    if (disabled) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    setError(null);
    setLoading(true);
    setItems([]);
    try {
      const list = await fetchItems();
      setItems(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        title={disabled ? 'Requires a resolved URI' : title}
        className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {loading ? (
          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h8m-8 4h4" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl w-52 py-1 max-h-60 overflow-y-auto">
          {error && (
            <div className="px-3 py-2 text-xs text-red-400">{error}</div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-500">No items found</div>
          )}
          {items.map(item => (
            <button
              key={item}
              type="button"
              onClick={() => { onSelect(item); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors font-mono"
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export interface MongoPanelProps {
  value: string;
  onChange: (value: string) => void;
  variableSuggestions?: VariableSuggestion[];
  /** Resolved URI (variables substituted). Used by fetch buttons. Empty/undefined disables them. */
  resolvedUri?: string;
  /** Resolved named connection id (variables substituted). Used by fetch buttons in named mode. */
  resolvedConnectionId?: string;
  /** Resolved database name (variables substituted). Used by collection fetch button. */
  resolvedDatabase?: string;
  /** Resolved auth override (variables substituted). Forwarded to introspect endpoints. */
  resolvedAuth?: MongoAuthOverride;
}

export default function MongoPanel({ value, onChange, variableSuggestions, resolvedUri, resolvedConnectionId, resolvedDatabase, resolvedAuth }: MongoPanelProps) {
  const [cfg, setCfg] = useState<MongoConfig>(() => parseMongoConfig(value) ?? DEFAULT_CONFIG);
  const [parseError, setParseError] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Sync inbound value changes (e.g. tab switch) → local state
  useEffect(() => {
    const parsed = parseMongoConfig(value);
    if (parsed) {
      setParseError(false);
      setCfg(parsed);
    } else if (value && value.trim()) {
      setParseError(true);
    } else {
      setParseError(false);
      setCfg(DEFAULT_CONFIG);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = useCallback((patch: Partial<MongoConfig>) => {
    setCfg(prev => {
      const next = { ...prev, ...patch };
      onChange(serialize(next));
      return next;
    });
  }, [onChange]);

  if (parseError) {
    return (
      <div className="p-3">
        <div className="rounded bg-red-900/30 border border-red-700 px-3 py-2 text-xs text-red-300 mb-3">
          The MongoDB configuration contains invalid JSON. Edit the raw JSON directly to fix it.
        </div>
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full bg-slate-700 border border-red-600 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500 resize-y"
        />
      </div>
    );
  }

  const op: Operation = (cfg.operation as Operation) ?? 'find';
  const needsCollection = op !== 'script';
  const hasResolvedUri = !!resolvedUri && !resolvedUri.includes('{{');
  const hasResolvedConnectionId = !!resolvedConnectionId && !resolvedConnectionId.includes('{{');
  const canFetchDbs = hasResolvedUri || hasResolvedConnectionId;
  const canFetchCols = canFetchDbs && !!resolvedDatabase && !resolvedDatabase.includes('{{');

  function handleInsertStage(stageJson: string) {
    let current = cfg.pipeline ?? '[]';
    try {
      const arr: unknown[] = JSON.parse(current);
      arr.push(JSON.parse(stageJson));
      current = JSON.stringify(arr, null, 2);
    } catch {
      current = current.trimEnd() + '\n' + stageJson;
    }
    update({ pipeline: current });
  }

  return (
    <div className="flex flex-col gap-4 p-3">

      {/* ── Database & Collection ─────────────────────────── */}
      <div className={`grid gap-3 ${needsCollection ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs text-slate-400">Database</span>
            <FetchPicker
              disabled={!canFetchDbs}
              title="Fetch databases from server"
              fetchItems={() => listMongoDatabases(hasResolvedUri ? resolvedUri : undefined, hasResolvedConnectionId ? resolvedConnectionId : undefined, resolvedAuth)}
              onSelect={v => update({ database: v })}
            />
          </div>
          <VarInput
            value={cfg.database ?? ''}
            onChange={v => update({ database: v })}
            placeholder="mydb  or  {{mongoDb}}"
            variableSuggestions={variableSuggestions ?? []}
            className="font-mono"
          />
        </div>
        {needsCollection && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs text-slate-400">Collection</span>
              <FetchPicker
                disabled={!canFetchCols}
                title="Fetch collections from database"
                fetchItems={() => listMongoCollections(hasResolvedUri ? resolvedUri : undefined, resolvedDatabase ?? '', hasResolvedConnectionId ? resolvedConnectionId : undefined, resolvedAuth)}
                onSelect={v => update({ collection: v })}
              />
            </div>
            <VarInput
              value={cfg.collection ?? ''}
              onChange={v => update({ collection: v })}
              placeholder="users"
              variableSuggestions={variableSuggestions ?? []}
              className="font-mono"
            />
          </div>
        )}
      </div>

      {/* ── Operation ─────────────────────────────────────── */}
      <div>
        <div className="text-xs text-slate-400 mb-1">Operation</div>
        <select
          value={op}
          onChange={e => update({ operation: e.target.value as Operation })}
          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
        >
          {OPERATIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.label} — {o.description}
            </option>
          ))}
        </select>
      </div>

      {/* ── Operation-specific fields ─────────────────────── */}

      {/* FIND */}
      {op === 'find' && (
        <>
          <JsonTextarea
            label="Filter"
            value={cfg.filter ?? '{}'}
            placeholder='{ "status": "active" }'
            rows={3}
            hint="supports {{variables}}"
            noValidate
            onChange={v => update({ filter: v })}
            variableSuggestions={variableSuggestions}
          />
          <div className="grid grid-cols-2 gap-3">
            <JsonTextarea
              label="Projection (optional)"
              value={cfg.projection ?? ''}
              placeholder='{ "_id": 1, "name": 1 }'
              rows={2}
              onChange={v => update({ projection: v || undefined })}
              variableSuggestions={variableSuggestions}
            />
            <JsonTextarea
              label="Sort (optional)"
              value={cfg.sort ?? ''}
              placeholder='{ "createdAt": -1 }'
              rows={2}
              onChange={v => update({ sort: v || undefined })}
              variableSuggestions={variableSuggestions}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-slate-400 mb-1">Skip</div>
              <input
                type="number"
                min={0}
                value={cfg.skip ?? 0}
                onChange={e => update({ skip: parseInt(e.target.value, 10) || 0 })}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
              />
            </div>
            <div>
              <div className="text-xs text-slate-400 mb-1">Limit <span className="text-slate-600">(1–5000)</span></div>
              <input
                type="number"
                min={1}
                max={5000}
                value={cfg.limit ?? 50}
                onChange={e => update({ limit: Math.min(5000, Math.max(1, parseInt(e.target.value, 10) || 50)) })}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
              />
            </div>
          </div>
        </>
      )}

      {/* AGGREGATE */}
      {op === 'aggregate' && (
        <>
          <JsonTextarea
            labelNode={
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">Pipeline</span>
                <MongoPipelineSnippets onInsert={handleInsertStage} />
              </div>
            }
            value={cfg.pipeline ?? '[]'}
            placeholder={'[{ "$match": { "status": "active" } }, { "$group": { "_id": "$userId" } }]'}
            rows={5}
            hint="JSON array of pipeline stages"
            noValidate
            onChange={v => update({ pipeline: v })}
            variableSuggestions={variableSuggestions}
          />
          <div className="w-40">
            <div className="text-xs text-slate-400 mb-1">Limit <span className="text-slate-600">(1–5000)</span></div>
            <input
              type="number"
              min={1}
              max={5000}
              value={cfg.limit ?? 50}
              onChange={e => update({ limit: Math.min(5000, Math.max(1, parseInt(e.target.value, 10) || 50)) })}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
            />
          </div>
        </>
      )}

      {/* INSERT */}
      {op === 'insert' && (
        <JsonTextarea
          label="Documents"
          value={cfg.documents ?? '[]'}
          placeholder={'[{ "name": "{{name}}", "email": "{{email}}" }]'}
          rows={5}
          hint="JSON array — single element uses insertOne, multiple uses insertMany"
          onChange={v => update({ documents: v })}
          variableSuggestions={variableSuggestions}
        />
      )}

      {/* UPDATE */}
      {op === 'update' && (
        <>
          <JsonTextarea
            label="Filter"
            value={cfg.filter ?? '{}'}
            placeholder='{ "_id": "{{docId}}" }'
            rows={3}
            hint="documents to match"
            noValidate
            onChange={v => update({ filter: v })}
            variableSuggestions={variableSuggestions}
          />
          <JsonTextarea
            label="Update"
            value={cfg.update ?? '{}'}
            placeholder='{ "$set": { "status": "active" } }'
            rows={3}
            hint="must use update operators ($set, $inc, …)"
            onChange={v => update({ update: v })}
            variableSuggestions={variableSuggestions}
          />
          <div>
            <div className="text-xs text-slate-400 mb-1.5">Update Mode</div>
            <div className="flex gap-4">
              {(['one', 'many'] as const).map(m => (
                <label key={m} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="updateMode"
                    value={m}
                    checked={(cfg.updateMode ?? 'one') === m}
                    onChange={() => update({ updateMode: m })}
                    className="accent-orange-500"
                  />
                  <span className="text-sm text-slate-300">{m === 'one' ? 'Update one' : 'Update many'}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      {/* DELETE */}
      {op === 'delete' && (
        <>
          <JsonTextarea
            label="Filter"
            value={cfg.filter ?? '{}'}
            placeholder='{ "status": "deleted" }'
            rows={3}
            hint="documents to match"
            noValidate
            onChange={v => update({ filter: v })}
            variableSuggestions={variableSuggestions}
          />
          <div>
            <div className="text-xs text-slate-400 mb-1.5">Delete Mode</div>
            <div className="flex gap-4">
              {(['one', 'many'] as const).map(m => (
                <label key={m} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="deleteMode"
                    value={m}
                    checked={(cfg.deleteMode ?? 'one') === m}
                    onChange={() => update({ deleteMode: m })}
                    className="accent-orange-500"
                  />
                  <span className="text-sm text-slate-300">{m === 'one' ? 'Delete one' : 'Delete many'}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      {/* COUNT */}
      {op === 'count' && (
        <JsonTextarea
          label="Filter"
          value={cfg.filter ?? '{}'}
          placeholder='{ "status": "active" }'
          rows={3}
          hint="supports {{variables}}"
          noValidate
          onChange={v => update({ filter: v })}
          variableSuggestions={variableSuggestions}
        />
      )}

      {/* DISTINCT */}
      {op === 'distinct' && (
        <>
          <div>
            <div className="text-xs text-slate-400 mb-1">Field</div>
            <VarInput
              value={cfg.distinctField ?? ''}
              onChange={v => update({ distinctField: v })}
              placeholder="status"
              variableSuggestions={variableSuggestions ?? []}
              className="font-mono"
            />
          </div>
          <JsonTextarea
            label="Filter (optional)"
            value={cfg.filter ?? '{}'}
            placeholder='{}'
            rows={2}
            onChange={v => update({ filter: v })}
            variableSuggestions={variableSuggestions}
          />
        </>
      )}

      {/* SCRIPT */}
      {op === 'script' && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-slate-400">Script</span>
            <span className="text-[10px] text-slate-600 italic">
              Globals: <span className="font-mono text-slate-500">db</span>, <span className="font-mono text-slate-500">ObjectId</span>, <span className="font-mono text-slate-500">result</span> (set to return value)
            </span>
          </div>
          <textarea
            value={cfg.script ?? ''}
            onChange={e => update({ script: e.target.value })}
            rows={8}
            spellCheck={false}
            placeholder={'const docs = await db.collection(\'users\').find({ active: true }).toArray();\nresult = docs.map(d => d.email);'}
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500 resize-y"
          />
        </div>
      )}

      {/* ── Advanced (collapsible) ────────────────────────── */}
      <div className="rounded border border-slate-700">
        <button
          type="button"
          onClick={() => setAdvancedOpen(o => !o)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          <span className="font-medium">Advanced</span>
          <svg className={`w-3.5 h-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {advancedOpen && (
          <div className="border-t border-slate-700 px-3 py-3 flex flex-col gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={cfg.useTransaction ?? false}
                onChange={e => update({ useTransaction: e.target.checked })}
                className="accent-orange-500"
              />
              <div>
                <div className="text-sm text-slate-300">Use Transaction</div>
                <div className="text-[10px] text-slate-500">Wraps the operation in a multi-document transaction (requires replica set)</div>
              </div>
            </label>
            <div className="w-48">
              <div className="text-xs text-slate-400 mb-1">Max Time (ms) <span className="text-slate-600">default: 1 800 000</span></div>
              <input
                type="number"
                min={1000}
                max={1800000}
                step={1000}
                value={cfg.maxTimeMS ?? ''}
                placeholder="1800000"
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  update({ maxTimeMS: isNaN(v) ? undefined : v });
                }}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
              />
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// Re-export types for MongoRequestPanel
export type { MongoConfig, ConnectionMode };
