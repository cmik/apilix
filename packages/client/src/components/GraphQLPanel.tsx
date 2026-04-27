import { useState, useRef, useEffect } from 'react';
import { graphqlIntrospect } from '../api';
import CodeEditor from './CodeEditor';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

// ─── Schema types ─────────────────────────────────────────────────────────────

interface GqlArg {
  name: string;
  typeStr: string;
}

interface GqlField {
  name: string;
  typeName: string;     // unwrapped base type name
  typeStr: string;      // display string like "[User!]!"
  hasSubfields: boolean;
  args: GqlArg[];
}

interface GqlTypeMap {
  [typeName: string]: GqlField[];
}

interface GqlSchema {
  queryType: string;
  mutationType: string | null;
  subscriptionType: string | null;
  types: GqlTypeMap;
}

// ─── Schema parsing ───────────────────────────────────────────────────────────

function resolveBaseTypeName(type: any): string {
  if (!type) return 'Unknown';
  if (type.kind === 'NON_NULL' || type.kind === 'LIST') return resolveBaseTypeName(type.ofType);
  return type.name ?? 'Unknown';
}

function resolveBaseTypeKind(type: any): string {
  if (!type) return 'SCALAR';
  if (type.kind === 'NON_NULL' || type.kind === 'LIST') return resolveBaseTypeKind(type.ofType);
  return type.kind ?? 'SCALAR';
}

function typeToStr(type: any): string {
  if (!type) return '';
  if (type.kind === 'NON_NULL') return `${typeToStr(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${typeToStr(type.ofType)}]`;
  return type.name ?? '';
}

const LEAF_KINDS = new Set(['SCALAR', 'ENUM', 'INPUT_OBJECT']);

function parseGraphQLSchema(data: any): GqlSchema | null {
  const schema = data?.data?.__schema;
  if (!schema) return null;

  const types: GqlTypeMap = {};
  for (const t of schema.types ?? []) {
    if (!t.name || t.name.startsWith('__')) continue;
    if (t.kind !== 'OBJECT' && t.kind !== 'INTERFACE') continue;
    types[t.name] = (t.fields ?? []).map((f: any) => ({
      name: f.name,
      typeName: resolveBaseTypeName(f.type),
      typeStr: typeToStr(f.type),
      hasSubfields: !LEAF_KINDS.has(resolveBaseTypeKind(f.type)),
      args: (f.args ?? []).map((a: any) => ({ name: a.name, typeStr: typeToStr(a.type) })),
    }));
  }

  return {
    queryType: schema.queryType?.name ?? 'Query',
    mutationType: schema.mutationType?.name ?? null,
    subscriptionType: schema.subscriptionType?.name ?? null,
    types,
  };
}

// ─── Context detection ────────────────────────────────────────────────────────

function detectContext(
  query: string,
  cursor: number,
  schema: GqlSchema,
): { typeName: string; word: string } {
  const textBefore = query.slice(0, cursor);
  const wordMatch = textBefore.match(/\w+$/);
  const word = wordMatch ? wordMatch[0] : '';
  const text = textBefore.slice(0, textBefore.length - word.length);

  // Determine root type from the operation keyword
  let rootType = schema.queryType;
  const opMatch = text.match(/^\s*(query|mutation|subscription)\b/i);
  if (opMatch) {
    const kw = opMatch[1].toLowerCase();
    if (kw === 'mutation' && schema.mutationType) rootType = schema.mutationType;
    else if (kw === 'subscription' && schema.subscriptionType) rootType = schema.subscriptionType;
  }

  // Walk the text tracking which type we're inside
  const typeStack: string[] = [rootType];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const before = text.slice(0, i).trimEnd();
      const fieldMatch = before.match(/(\w+)\s*(?:\([^)]*\))?\s*$/);
      if (fieldMatch) {
        const name = fieldMatch[1];
        const lname = name.toLowerCase();
        if (lname === 'query') {
          typeStack.push(schema.queryType);
        } else if (lname === 'mutation' && schema.mutationType) {
          typeStack.push(schema.mutationType);
        } else if (lname === 'subscription' && schema.subscriptionType) {
          typeStack.push(schema.subscriptionType);
        } else {
          const current = typeStack[typeStack.length - 1];
          const f = (schema.types[current] ?? []).find(ff => ff.name === name);
          typeStack.push(f?.typeName ?? '');
        }
      } else {
        typeStack.push(typeStack[typeStack.length - 1]);
      }
    } else if (ch === '}') {
      if (typeStack.length > 1) typeStack.pop();
    }
  }

  return { typeName: typeStack[typeStack.length - 1], word };
}

// ─── Cursor position helper ───────────────────────────────────────────────────

function getDropdownPos(textarea: HTMLTextAreaElement): { top: number; left: number } {
  const computed = getComputedStyle(textarea);
  const lineHeight = parseFloat(computed.lineHeight) || 20;
  const paddingTop = parseFloat(computed.paddingTop) || 8;
  const paddingLeft = parseFloat(computed.paddingLeft) || 12;
  const textBefore = textarea.value.slice(0, textarea.selectionStart);
  const lineCount = textBefore.split('\n').length;
  return {
    top: paddingTop + lineCount * lineHeight - textarea.scrollTop,
    left: paddingLeft,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface GraphQLPanelProps {
  query: string;
  variables: string;
  url: string;
  headers: Array<{ key: string; value: string; disabled?: boolean }>;
  variableSuggestions?: VariableSuggestion[];
  onQueryChange: (q: string) => void;
  onVariablesChange: (v: string) => void;
}

export default function GraphQLPanel({
  query,
  variables,
  url,
  headers,
  variableSuggestions,
  onQueryChange,
  onVariablesChange,
}: GraphQLPanelProps) {
  const [schema, setSchema] = useState<GqlSchema | null>(null);
  const [introspecting, setIntrospecting] = useState(false);
  const [introspectError, setIntrospectError] = useState('');
  const [introspectDisabled, setIntrospectDisabled] = useState(false);
  const [introspectedUrl, setIntrospectedUrl] = useState('');
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [schemaFilter, setSchemaFilter] = useState('');

  // Load-schema modal
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadJson, setLoadJson] = useState('');
  const [loadError, setLoadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Autocomplete state
  const [acSuggestions, setAcSuggestions] = useState<GqlField[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [acPos, setAcPos] = useState<{ top: number; left: number } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ─── Introspect from server ─────────────────────────────────────────────────

  async function handleIntrospect() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setIntrospectError('URL is empty');
      return;
    }
    setIntrospecting(true);
    setIntrospectError('');
    setIntrospectDisabled(false);
    try {
      const result = await graphqlIntrospect(
        trimmedUrl,
        headers.filter(h => !h.disabled),
      );
      if (result.error) {
        setIntrospectError(result.error);
        return;
      }
      let data: any;
      try {
        data = JSON.parse(result.body);
      } catch {
        setIntrospectError('Response is not valid JSON');
        return;
      }
      if (data.errors?.length) {
        const msg: string = data.errors[0]?.message ?? 'GraphQL error';
        // Detect Apollo / graphql-js introspection-disabled responses
        if (
          msg.toLowerCase().includes('introspection') ||
          msg.includes('__schema') ||
          msg.includes('__type')
        ) {
          setIntrospectDisabled(true);
          setIntrospectError(msg);
        } else {
          setIntrospectError(msg);
        }
        return;
      }
      const parsed = parseGraphQLSchema(data);
      if (!parsed) {
        setIntrospectError('Could not parse schema from introspection response');
        return;
      }
      setSchema(parsed);
      setIntrospectedUrl(trimmedUrl);
      setSchemaOpen(true);
    } catch (err) {
      setIntrospectError((err as Error).message);
    } finally {
      setIntrospecting(false);
    }
  }

  // ─── Load schema from pasted / uploaded introspection JSON ─────────────────

  function applyIntrospectionJson(json: string): boolean {
    let data: any;
    try {
      data = JSON.parse(json);
    } catch {
      setLoadError('Not valid JSON');
      return false;
    }
    // Accept either a raw introspection result or the { data: __schema } wrapper
    const wrapped = data?.data ?? data;
    const parsed = parseGraphQLSchema(wrapped);
    if (!parsed) {
      setLoadError('Could not find __schema in the JSON. Make sure this is a GraphQL introspection result.');
      return false;
    }
    setSchema(parsed);
    setIntrospectedUrl('');   // wasn't fetched from URL
    setIntrospectDisabled(false);
    setIntrospectError('');
    setSchemaOpen(true);
    return true;
  }

  function handleLoadFromJson() {
    setLoadError('');
    if (!loadJson.trim()) { setLoadError('Paste an introspection JSON result first'); return; }
    if (applyIntrospectionJson(loadJson)) {
      setShowLoadModal(false);
      setLoadJson('');
    }
  }

  function handleLoadFromFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      setLoadJson(text);
      setLoadError('');
    };
    reader.readAsText(file);
    // reset so the same file can be re-selected
    e.target.value = '';
  }

  function getSuggestions(value: string, cursor: number): GqlField[] {
    if (!schema) return [];
    const { typeName, word } = detectContext(value, cursor, schema);
    if (!typeName || !schema.types[typeName]) return [];
    const fields = schema.types[typeName];
    if (!word) return [];
    return fields
      .filter(f => f.name.toLowerCase().startsWith(word.toLowerCase()))
      .slice(0, 12);
  }

  function updateAutocomplete(value: string, cursor: number) {
    if (!schema || !textareaRef.current) {
      setAcSuggestions([]);
      return;
    }
    const suggestions = getSuggestions(value, cursor);
    if (suggestions.length === 0) {
      setAcSuggestions([]);
      return;
    }
    setAcSuggestions(suggestions);
    setAcIndex(0);
    setAcPos(getDropdownPos(textareaRef.current));
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    onQueryChange(value);
    updateAutocomplete(value, e.target.selectionStart);
  }

  function handleQueryKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (acSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAcIndex(i => Math.min(i + 1, acSuggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAcIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      commitSuggestion(acSuggestions[acIndex]);
    } else if (e.key === 'Escape') {
      setAcSuggestions([]);
    }
  }

  function buildInsertion(field: GqlField): { text: string; cursorFromStart: number } {
    let text = field.name;
    if (field.args.length > 0) {
      text += `(${field.args.map(a => `${a.name}: `).join(', ')})`;
    }
    const cursorFromStart = text.length;
    if (field.hasSubfields) {
      text += ' {\n  \n}';
    }
    return { text, cursorFromStart };
  }

  function commitSuggestion(field: GqlField) {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursor = textarea.selectionStart;
    const value = textarea.value;
    const textBefore = value.slice(0, cursor);
    const wordMatch = textBefore.match(/\w+$/);
    const wordStart = wordMatch ? cursor - wordMatch[0].length : cursor;

    const { text: insertion, cursorFromStart } = buildInsertion(field);
    const newValue = value.slice(0, wordStart) + insertion + value.slice(cursor);

    onQueryChange(newValue);
    setAcSuggestions([]);

    setTimeout(() => {
      if (!textareaRef.current) return;
      const newCursor = wordStart + cursorFromStart;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(newCursor, newCursor);
    }, 0);
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (textareaRef.current && !textareaRef.current.contains(target)) {
        // allow clicks on the dropdown itself (handled via onMouseDown preventDefault)
        const dropdown = document.getElementById('gql-ac-dropdown');
        if (!dropdown?.contains(target)) {
          setAcSuggestions([]);
        }
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const typeCount = schema ? Object.keys(schema.types).length : 0;
  const urlChanged = schema && introspectedUrl && url.trim() !== introspectedUrl;

  const rootEntries = schema ? [
    { label: 'Query', typeName: schema.queryType, color: 'text-emerald-400' },
    ...(schema.mutationType ? [{ label: 'Mutation', typeName: schema.mutationType, color: 'text-orange-400' }] : []),
    ...(schema.subscriptionType ? [{ label: 'Subscription', typeName: schema.subscriptionType, color: 'text-violet-400' }] : []),
  ] : [];

  return (
    <div className="flex flex-col gap-3">
      {/* Introspection toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleIntrospect}
          disabled={introspecting}
          className="px-3 py-1 bg-violet-700 hover:bg-violet-600 disabled:bg-slate-600 disabled:text-slate-500 text-white text-xs font-medium rounded transition-colors flex items-center gap-1.5 shrink-0"
        >
          {introspecting ? (
            <>
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Fetching schema…
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Fetch Schema
            </>
          )}
        </button>

        {/* Load from file / paste — always visible */}
        <button
          onClick={() => { setLoadJson(''); setLoadError(''); setShowLoadModal(true); }}
          className="px-3 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-300 hover:text-slate-100 text-xs font-medium rounded transition-colors flex items-center gap-1.5 shrink-0"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Load Schema
        </button>

        {schema && (
          <span className="text-xs text-slate-400 flex items-center gap-1">
            <svg className="w-3 h-3 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Schema loaded ·{' '}
            <button
              onClick={() => setSchemaOpen(o => !o)}
              className="text-violet-400 hover:text-violet-300 transition-colors"
            >
              {typeCount} type{typeCount !== 1 ? 's' : ''} {schemaOpen ? '▲' : '▼'}
            </button>
          </span>
        )}

        {urlChanged && (
          <span className="text-xs text-yellow-400 flex items-center gap-1">
            <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            URL changed — re-fetch schema
          </span>
        )}

        {introspectError && (
          <span className="text-xs text-slate-400 flex items-start gap-1.5 w-full mt-0.5">
            <svg className="w-3 h-3 shrink-0 text-red-400 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span>
              <span className="text-red-400">{introspectError}</span>
              {introspectDisabled && (
                <>
                  {' '}—{' '}
                  <span className="text-slate-400">
                    This API has introspection disabled in production. You can{' '}
                    <button
                      onClick={() => { setLoadJson(''); setLoadError(''); setShowLoadModal(true); }}
                      className="text-violet-400 hover:text-violet-300 underline underline-offset-2 transition-colors"
                    >
                      load the schema manually
                    </button>
                    {' '}by pasting or uploading an introspection JSON result.
                  </span>
                </>
              )}
            </span>
          </span>
        )}

        {schema && !schemaOpen && !introspectError && (
          <span className="ml-auto text-xs text-slate-600 italic">
            Type to autocomplete · Tab / ↵ to insert
          </span>
        )}
      </div>

      {/* Schema Explorer */}
      {schema && schemaOpen && (
        <div className="border border-slate-600 rounded bg-slate-900/60 overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-2">
            <span className="text-xs font-semibold text-violet-400">Schema Explorer</span>
            <span className="text-xs text-slate-600">Click a field to insert at cursor</span>
            <input
              value={schemaFilter}
              onChange={e => setSchemaFilter(e.target.value)}
              placeholder="Filter fields…"
              className="ml-auto bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-xs text-slate-300 focus:outline-none focus:border-violet-500 w-36"
            />
            <button
              onClick={() => setSchemaOpen(false)}
              className="text-slate-600 hover:text-slate-400 text-base leading-none ml-1"
              title="Close"
            >
              ×
            </button>
          </div>
          <div className="max-h-60 overflow-y-auto p-3 space-y-4">
            {rootEntries.map(({ label, typeName, color }) => {
              const fields = (schema.types[typeName] ?? []).filter(f =>
                !schemaFilter || f.name.toLowerCase().includes(schemaFilter.toLowerCase()),
              );
              if (fields.length === 0 && schemaFilter) return null;
              return (
                <div key={typeName}>
                  <p className={`text-xs font-semibold ${color} mb-1.5 uppercase tracking-wide`}>
                    {label}
                  </p>
                  <div className="space-y-px pl-2">
                    {fields.map(f => (
                      <button
                        key={f.name}
                        onMouseDown={e => {
                          e.preventDefault();
                          textareaRef.current?.focus();
                          commitSuggestion(f);
                        }}
                        className="w-full text-left flex items-baseline gap-2 px-2 py-1 rounded hover:bg-slate-700/60 transition-colors"
                      >
                        <span className="font-mono text-xs text-slate-200 shrink-0">{f.name}</span>
                        {f.args.length > 0 && (
                          <span className="font-mono text-xs text-slate-500 shrink-0">
                            ({f.args.map(a => a.name).join(', ')})
                          </span>
                        )}
                        <span className={`font-mono text-xs ml-auto shrink-0 ${color}`}>{f.typeStr}</span>
                      </button>
                    ))}
                    {fields.length === 0 && (
                      <p className="text-xs text-slate-600 italic pl-2">No fields</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Query editor */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-slate-400 font-medium">Query</label>
        <div className="relative">
          <CodeEditor
            ref={textareaRef}
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleQueryKeyDown}
            onMouseUp={() => {
              if (schema && textareaRef.current) {
                updateAutocomplete(textareaRef.current.value, textareaRef.current.selectionStart);
              }
            }}
            onScroll={() => setAcSuggestions([])}
            rows={8}
            language="graphql"
            placeholder={'query {\n  ...\n}'}
          />

          {/* Autocomplete dropdown */}
          {acSuggestions.length > 0 && acPos && (
            <div
              id="gql-ac-dropdown"
              className="absolute z-20 bg-slate-800 border border-violet-700/60 rounded shadow-2xl min-w-52 max-h-52 overflow-y-auto"
              style={{ top: acPos.top, left: acPos.left }}
            >
              {acSuggestions.map((f, i) => (
                <button
                  key={f.name}
                  onMouseDown={e => { e.preventDefault(); commitSuggestion(f); }}
                  className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 text-xs font-mono transition-colors ${
                    i === acIndex
                      ? 'bg-violet-700/50 text-slate-100'
                      : 'hover:bg-slate-700 text-slate-300'
                  }`}
                >
                  <span className="text-slate-100 shrink-0">{f.name}</span>
                  {f.args.length > 0 && (
                    <span className="text-slate-500 text-xs shrink-0">
                      ({f.args.map(a => a.name).join(', ')})
                    </span>
                  )}
                  <span className="ml-auto text-violet-400 shrink-0">{f.typeStr}</span>
                </button>
              ))}
              <div className="px-3 py-1 border-t border-slate-700 text-xs text-slate-600 flex justify-between">
                <span>↑↓ navigate</span>
                <span>Tab / ↵ insert</span>
                <span>Esc dismiss</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Variables editor */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-slate-400 font-medium">Variables</label>
        <CodeEditor
          value={variables}
          onChange={e => onVariablesChange(e.target.value)}
          rows={4}
          language="json"
          variableSuggestions={variableSuggestions}
          placeholder={'{ "variable": "value" }'}
        />
      </div>

      {/* Load Schema modal */}
      {showLoadModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setShowLoadModal(false); }}
        >
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl w-full max-w-2xl mx-4 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200">Load GraphQL Schema</h3>
              <button onClick={() => setShowLoadModal(false)} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
            </div>

            <div className="px-4 pt-3 pb-1">
              <div className="flex items-start gap-2 bg-slate-700/40 border border-slate-600 rounded px-3 py-2.5 mb-3">
                <svg className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zm-1 4a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Paste the result of a{' '}
                  <code className="text-orange-400 bg-slate-900 px-1 py-0.5 rounded text-xs">{"{ __schema { ... } }"}</code>{' '}
                  introspection query, or upload a saved <code className="text-orange-400">.json</code> file.
                  You can generate one from a dev environment or using tools like{' '}
                  <span className="text-slate-400">graphql-inspector</span>,{' '}
                  <span className="text-slate-400">get-graphql-schema</span>, or Apollo Studio export.
                </p>
              </div>
            </div>

            <div className="px-4 pb-4 flex flex-col gap-3">
              {/* File upload */}
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleLoadFromFile}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-300 text-xs rounded transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Upload .json file
                </button>
                <span className="text-xs text-slate-600">or paste below</span>
              </div>

              <textarea
                autoFocus
                value={loadJson}
                onChange={e => { setLoadJson(e.target.value); setLoadError(''); }}
                rows={12}
                spellCheck={false}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-xs font-mono text-slate-300 focus:outline-none focus:border-violet-500 resize-y"
                placeholder={'{\n  "data": {\n    "__schema": { ... }\n  }\n}'}
              />

              {loadError && (
                <p className="text-xs text-red-400 flex items-center gap-1">
                  <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {loadError}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowLoadModal(false)}
                  className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleLoadFromJson}
                  className="px-4 py-1.5 bg-violet-700 hover:bg-violet-600 text-white text-sm font-medium rounded transition-colors"
                >
                  Load Schema
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
