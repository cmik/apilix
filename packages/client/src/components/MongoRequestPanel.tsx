import { useState, useCallback, useMemo } from 'react';
import { marked } from 'marked';
import MongoPanel from './MongoPanel';
import type { MongoConfig, ConnectionMode } from './MongoPanel';
import { parseMongoConfig } from './MongoPanel';
import ScriptTab from './ScriptTab';
import VarInput from './VarInput';
import { useApp } from '../store';
import type { VariableSuggestion } from '../utils/variableAutocomplete';
import type { MongoDBConnectionConfig } from '../types';
import { resolveVariables, extractUsedVariables } from '../utils/variableResolver';
import type { MongoUsedVariable, MongoUsedVarScope } from '../utils/variableResolver';

// ─── Types ────────────────────────────────────────────────────────────────────

type MainTab = 'Connection' | 'Query' | 'Pre-request' | 'Tests' | 'Docs';
type ResolvedMongoAuth = {
  mode?: string;
  username?: string;
  password?: string;
  authSource?: string;
};

export interface MongoRequestPanelProps {
  bodyRaw: string;
  preRequestScript: string;
  testScript: string;
  description: string;
  variableSuggestions: VariableSuggestion[];
  preRequestHasError: boolean;
  testHasError: boolean;
  activeTabId: string | null;
  requestNames: string[];
  requestItems: Array<{ id: string; name: string }>;
  /** Merged env+globals+collectionVars record for resolving variables in fetch buttons */
  resolvedVars: Record<string, string>;
  /** Individual scope maps — used to classify and edit variables in the Used Variables panel */
  envVars: Record<string, string>;
  collVars: Record<string, string>;
  globals: Record<string, string>;
  collectionDefinitionVars: Record<string, string>;
  /** True when there is an active environment to write env-scope variables into */
  hasActiveEnv: boolean;
  /** Called when the user edits or creates a variable value from the Used Variables panel */
  onVarEdit: (name: string, value: string, scope: 'env' | 'coll' | 'global') => void;
  onBodyChange: (v: string) => void;
  onPreRequestChange: (v: string) => void;
  onTestChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onPreRequestSyntaxCheck: (hasError: boolean) => void;
  onTestSyntaxCheck: (hasError: boolean) => void;
}

// ─── Scope badge helpers ─────────────────────────────────────────────────────

const SCOPE_BADGE: Record<MongoUsedVarScope, { label: string; cls: string }> = {
  ENV:            { label: 'ENV',    cls: 'bg-sky-900 text-sky-300' },
  COLL:           { label: 'COLL',   cls: 'bg-purple-900 text-purple-300' },
  GLOBAL:         { label: 'GLOBAL', cls: 'bg-slate-700 text-slate-300' },
  COLLECTION_DEF: { label: 'COL-DEF', cls: 'bg-slate-700 text-slate-400' },
  DYNAMIC:        { label: 'DYNAMIC', cls: 'bg-emerald-900 text-emerald-300' },
  UNRESOLVED:     { label: 'UNRESOLVED', cls: 'bg-red-900 text-red-300' },
};

const DEFAULT_EDIT_SCOPE: 'env' | 'coll' | 'global' = 'env';

// ─── Used Variables panel ────────────────────────────────────────────────────

export function UsedVariablesSection({
  usedVars,
  hasActiveEnv,
  onVarEdit,
}: {
  usedVars: MongoUsedVariable[];
  hasActiveEnv: boolean;
  onVarEdit: (name: string, value: string, scope: 'env' | 'coll' | 'global') => void;
}) {
  const [open, setOpen] = useState(true);
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const [createScopes, setCreateScopes] = useState<Record<string, 'env' | 'coll' | 'global'>>({});

  if (usedVars.length === 0) return null;

  const unresolvedCount = usedVars.filter(v => v.scope === 'UNRESOLVED').length;

  function scopeForVar(v: MongoUsedVariable): 'env' | 'coll' | 'global' {
    if (v.scope === 'ENV')    return 'env';
    if (v.scope === 'COLL')   return 'coll';
    if (v.scope === 'GLOBAL') return 'global';
    // UNRESOLVED — use user-chosen scope or sensible default
    return createScopes[v.name] ?? (hasActiveEnv ? DEFAULT_EDIT_SCOPE : 'global');
  }

  function handleApply(v: MongoUsedVariable) {
    const value = pendingEdits[v.name] ?? v.resolvedValue;
    onVarEdit(v.name, value, scopeForVar(v));
    setPendingEdits(prev => { const next = { ...prev }; delete next[v.name]; return next; });
  }

  function handleKeyDown(e: React.KeyboardEvent, v: MongoUsedVariable) {
    if (e.key === 'Enter') { e.preventDefault(); handleApply(v); }
  }

  return (
    <div className="border-t border-slate-700">
      {/* Section header */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-slate-750 text-left"
      >
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
          <span className="text-xs font-semibold text-slate-300">Used Variables</span>
          <span className="text-[10px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded-full">{usedVars.length}</span>
          {unresolvedCount > 0 && (
            <span className="text-[10px] bg-red-900 text-red-300 px-1.5 py-0.5 rounded-full">
              {unresolvedCount} unresolved
            </span>
          )}
        </div>
        <svg className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="bg-slate-900/40">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 uppercase tracking-wide text-[10px] border-b border-slate-800">
                <th className="pl-3 pr-2 py-1.5 text-left font-medium w-32">Variable</th>
                <th className="pr-2 py-1.5 text-left font-medium w-24">Scope</th>
                <th className="pr-3 py-1.5 text-left font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {usedVars.map(v => {
                const badge = SCOPE_BADGE[v.scope];
                const pendingValue = pendingEdits[v.name];
                const displayValue = pendingValue !== undefined ? pendingValue : v.resolvedValue;
                const isDirty = pendingValue !== undefined && pendingValue !== v.resolvedValue;

                return (
                  <tr key={v.name} className="border-t border-slate-800 hover:bg-slate-800/30">
                    {/* Name */}
                    <td className="pl-3 pr-2 py-1.5 font-mono text-slate-200 truncate max-w-0 w-32">
                      <span title={v.name} className="truncate block">{v.name}</span>
                    </td>

                    {/* Scope badge */}
                    <td className="pr-2 py-1.5 w-24">
                      {v.scope === 'UNRESOLVED' ? (
                        <select
                          value={createScopes[v.name] ?? (hasActiveEnv ? 'env' : 'global')}
                          onChange={e => setCreateScopes(prev => ({ ...prev, [v.name]: e.target.value as 'env' | 'coll' | 'global' }))}
                          className="bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[10px] text-slate-300 focus:outline-none focus:border-orange-500"
                        >
                          {hasActiveEnv && <option value="env">ENV</option>}
                          <option value="coll">COLL</option>
                          <option value="global">GLOBAL</option>
                        </select>
                      ) : (
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase leading-none ${badge.cls}`}>
                          {badge.label}
                        </span>
                      )}
                    </td>

                    {/* Value / action */}
                    <td className="pr-3 py-1.5">
                      {v.scope === 'DYNAMIC' ? (
                        <span className="text-slate-500 italic">auto-generated at send</span>
                      ) : v.scope === 'COLLECTION_DEF' ? (
                        <span className="font-mono text-slate-400 text-[11px]" title={v.resolvedValue}>
                          {v.resolvedValue || <span className="italic text-slate-600">empty</span>}
                          <span className="ml-2 text-slate-600 non-italic">(collection settings)</span>
                        </span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={displayValue}
                            onChange={e => setPendingEdits(prev => ({ ...prev, [v.name]: e.target.value }))}
                            onKeyDown={e => handleKeyDown(e, v)}
                            placeholder={v.scope === 'UNRESOLVED' ? 'enter value…' : undefined}
                            className={`flex-1 bg-slate-800 border rounded px-2 py-0.5 font-mono text-[11px] text-slate-200 focus:outline-none min-w-0 ${
                              v.scope === 'UNRESOLVED'
                                ? 'border-red-700 focus:border-red-500'
                                : isDirty
                                  ? 'border-orange-600 focus:border-orange-400'
                                  : 'border-slate-600 focus:border-orange-500'
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => handleApply(v)}
                            title={v.scope === 'UNRESOLVED' ? 'Create variable' : 'Apply value'}
                            aria-label={v.scope === 'UNRESOLVED' ? 'Create variable' : 'Apply value'}
                            className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                              v.scope === 'UNRESOLVED'
                                ? 'bg-orange-700 hover:bg-orange-600 text-white'
                                : isDirty
                                  ? 'bg-orange-700 hover:bg-orange-600 text-white'
                                  : 'bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {v.scope === 'UNRESOLVED' ? 'Create' : 'Apply'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MongoRequestPanel({
  bodyRaw,
  preRequestScript,
  testScript,
  description,
  variableSuggestions,
  preRequestHasError,
  testHasError,
  activeTabId,
  requestNames,
  requestItems,
  resolvedVars,
  envVars,
  collVars,
  globals,
  collectionDefinitionVars,
  hasActiveEnv,
  onVarEdit,
  onBodyChange,
  onPreRequestChange,
  onTestChange,
  onDescriptionChange,
  onPreRequestSyntaxCheck,
  onTestSyntaxCheck,
}: MongoRequestPanelProps) {
  const { state } = useApp();
  const [activeTab, setActiveTab] = useState<MainTab>('Query');
  const [docsMode, setDocsMode] = useState<'edit' | 'preview'>('edit');

  const savedConns = useMemo(
    () => state.databases.filter((d): d is MongoDBConnectionConfig => d.type === 'mongodb'),
    [state.databases],
  );
  const [authOpen, setAuthOpen] = useState(false);

  // Parse the shared JSON blob for connection/auth fields
  const parsedCfg: MongoConfig | null = parseMongoConfig(bodyRaw);
  const connMode: ConnectionMode = parsedCfg?.connection?.mode ?? 'direct';

  // Merge a patch into the JSON blob and propagate
  const patchCfg = useCallback((patch: Partial<MongoConfig>) => {
    const current = parseMongoConfig(bodyRaw) ?? {};
    onBodyChange(JSON.stringify({ ...current, ...patch }, null, 2));
  }, [bodyRaw, onBodyChange]);

  const patchConnection = useCallback((patch: Partial<NonNullable<MongoConfig['connection']>>) => {
    const current = parseMongoConfig(bodyRaw) ?? {};
    const conn = current.connection ?? { mode: 'direct' as const };
    onBodyChange(JSON.stringify({ ...current, connection: { ...conn, ...patch } as MongoConfig['connection'] }, null, 2));
  }, [bodyRaw, onBodyChange]);

  const patchAuth = useCallback((patch: Partial<NonNullable<MongoConfig['auth']>>) => {
    const current = parseMongoConfig(bodyRaw) ?? {};
    onBodyChange(JSON.stringify({ ...current, auth: { ...(current.auth ?? {}), ...patch } }, null, 2));
  }, [bodyRaw, onBodyChange]);

  const patchAuthMode = useCallback((mode: NonNullable<MongoConfig['auth']>['mode']) => {
    const current = parseMongoConfig(bodyRaw) ?? {};
    const nextAuth = {
      ...(current.auth ?? {}),
      mode,
    } as NonNullable<MongoConfig['auth']>;

    if (mode === 'x509' || mode === 'oidc') {
      delete nextAuth.username;
      delete nextAuth.password;
    }

    onBodyChange(JSON.stringify({ ...current, auth: nextAuth }, null, 2));
  }, [bodyRaw, onBodyChange]);

  // Compute resolved URI and database for fetch buttons
  const rawUri = parsedCfg?.connection?.uri ?? '';
  const rawConnectionId = parsedCfg?.connection?.connectionId ?? '';
  const rawDatabase = parsedCfg?.database ?? '';
  const resolvedDirectUri = resolveVariables(rawUri, resolvedVars);
  const resolvedConnectionId = resolveVariables(rawConnectionId, resolvedVars);
  const matchedNamedConnection = savedConns.find(c => c._id === resolvedConnectionId);
  const resolvedNamedUri = matchedNamedConnection?.connectionUri
    ? resolveVariables(matchedNamedConnection.connectionUri, resolvedVars)
    : '';
  const resolvedUri = connMode === 'named' ? resolvedNamedUri : resolvedDirectUri;
  const resolvedDatabase = resolveVariables(rawDatabase, resolvedVars);

  // Resolve auth with precedence: request-level override > named connection auth.
  const rawAuth = parsedCfg?.auth;
  const namedAuth = connMode === 'named' ? matchedNamedConnection?.auth : undefined;
  const resolvedNamedAuth: ResolvedMongoAuth | undefined = namedAuth?.mode ? {
    mode: resolveVariables(namedAuth.mode, resolvedVars),
    username: namedAuth.username ? resolveVariables(namedAuth.username, resolvedVars) : undefined,
    password: namedAuth.password ? resolveVariables(namedAuth.password, resolvedVars) : undefined,
    authSource: namedAuth.authSource ? resolveVariables(namedAuth.authSource, resolvedVars) : undefined,
  } : undefined;
  const resolvedRequestMode = rawAuth?.mode ? resolveVariables(rawAuth.mode, resolvedVars) : undefined;
  const resolvedRequestAuth: ResolvedMongoAuth | undefined = rawAuth?.mode ? {
    mode: resolvedRequestMode,
    username: (resolvedRequestMode === 'scram' || resolvedRequestMode === 'ldap-plain')
      ? (rawAuth.username ? resolveVariables(rawAuth.username, resolvedVars) : undefined)
      : undefined,
    password: (resolvedRequestMode === 'scram' || resolvedRequestMode === 'ldap-plain')
      ? (rawAuth.password ? resolveVariables(rawAuth.password, resolvedVars) : undefined)
      : undefined,
    authSource: rawAuth.authSource ? resolveVariables(rawAuth.authSource, resolvedVars) : undefined,
  } : undefined;
  const resolvedAuth = (() => {
    if (!resolvedNamedAuth && !resolvedRequestAuth) return undefined;
    const merged: ResolvedMongoAuth = { ...(resolvedNamedAuth || {}) };
    if (resolvedRequestAuth?.mode !== undefined) merged.mode = resolvedRequestAuth.mode;
    if (resolvedRequestAuth?.username !== undefined) merged.username = resolvedRequestAuth.username;
    if (resolvedRequestAuth?.password !== undefined) merged.password = resolvedRequestAuth.password;
    if (resolvedRequestAuth?.authSource !== undefined) merged.authSource = resolvedRequestAuth.authSource;
    return merged.mode ? merged : undefined;
  })();

  const usedVars = useMemo(
    () => extractUsedVariables(bodyRaw, envVars, collVars, globals, collectionDefinitionVars),
    [bodyRaw, envVars, collVars, globals, collectionDefinitionVars],
  );

  const TABS: { id: MainTab; hasError?: boolean }[] = [
    { id: 'Connection' },
    { id: 'Query' },
    { id: 'Pre-request', hasError: preRequestHasError && !!preRequestScript.trim() },
    { id: 'Tests', hasError: testHasError && !!testScript.trim() },
    { id: 'Docs' },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex border-b border-slate-700 bg-slate-800 shrink-0">
        {TABS.map(({ id, hasError }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`relative px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === id
                ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {id}
            {hasError && (
              <span className="absolute top-1.5 right-1 w-1.5 h-1.5 rounded-full bg-red-500" title="Syntax error in script" />
            )}
          </button>
        ))}
      </div>

      {/* ── Tab content ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* QUERY */}
        {activeTab === 'Query' && (
          <>
            <MongoPanel
              value={bodyRaw}
              onChange={onBodyChange}
              variableSuggestions={variableSuggestions}
              databases={state.databases}
              resolvedUri={resolvedUri}
              resolvedConnectionId={resolvedConnectionId}
              resolvedDatabase={resolvedDatabase}
              resolvedAuth={resolvedAuth}
            />
            <UsedVariablesSection
              usedVars={usedVars}
              hasActiveEnv={hasActiveEnv}
              onVarEdit={onVarEdit}
            />
          </>
        )}

        {/* CONNECTION */}
        {activeTab === 'Connection' && (
          <div className="flex flex-col gap-4 p-3">

            {/* Mode toggle */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">Connection Mode</div>
              <div className="flex gap-4">
                {(['direct', 'named'] as ConnectionMode[]).map(m => (
                  <label key={m} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="connMode"
                      value={m}
                      checked={connMode === m}
                      onChange={() => {
                        if (m === 'direct') {
                          patchCfg({ connection: { mode: 'direct', uri: parsedCfg?.connection?.uri ?? '{{mongoUri}}' } });
                        } else {
                          patchCfg({ connection: { mode: 'named', connectionId: parsedCfg?.connection?.connectionId ?? '' } });
                        }
                      }}
                      className="accent-orange-500"
                    />
                    <span className="text-sm text-slate-300">{m === 'named' ? 'Named Connection' : 'Direct URI'}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Direct URI */}
            {connMode === 'direct' && (
              <div>
                <div className="text-xs text-slate-400 mb-1">Connection URI</div>
                <VarInput
                  value={parsedCfg?.connection?.uri ?? ''}
                  onChange={v => patchConnection({ uri: v })}
                  placeholder="mongodb://localhost:27017  or  {{mongoUri}}"
                  variableSuggestions={variableSuggestions ?? []}
                  className="font-mono"
                />
                <div className="mt-1 text-[10px] text-slate-500">
                  Use <span className="text-slate-400 font-mono">{'{{mongoUri}}'}</span> to swap the URI per environment.
                </div>
              </div>
            )}

            {/* Named connection */}
            {connMode === 'named' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs text-slate-400">Named Connection</div>
                </div>
                {savedConns.length > 0 ? (
                  <select
                    value={parsedCfg?.connection?.connectionId ?? ''}
                    onChange={e => patchConnection({ connectionId: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
                  >
                    <option value="" disabled>— select a connection —</option>
                    {savedConns.map(c => (
                      <option key={c._id} value={c._id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <VarInput
                      value={parsedCfg?.connection?.connectionId ?? ''}
                      onChange={v => patchConnection({ connectionId: v })}
                      placeholder="connection-id  (e.g. atlas-dev)"
                      variableSuggestions={variableSuggestions ?? []}
                      className="font-mono"
                    />
                    <div className="mt-1 text-[10px] text-slate-500">
                      No saved connections found. Add one via <span className="text-slate-400">Settings → Databases</span>.
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Auth Override (collapsible) */}
            <div className="rounded border border-slate-700">
              <button
                type="button"
                onClick={() => setAuthOpen(o => !o)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
              >
                <span className="font-medium">Auth Override <span className="text-slate-600 font-normal">(optional — overrides credentials in URI)</span></span>
                <svg className={`w-3.5 h-3.5 transition-transform ${authOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {authOpen && (
                <div className="border-t border-slate-700 px-3 py-3 flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-slate-400 mb-1">Auth Mode</div>
                      <select
                        value={parsedCfg?.auth?.mode ?? 'scram'}
                        onChange={e => patchAuthMode(e.target.value as NonNullable<MongoConfig['auth']>['mode'])}
                        className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
                      >
                        <option value="scram">SCRAM (username + password)</option>
                        <option value="x509">X.509 certificate</option>
                        <option value="ldap-plain">LDAP / PLAIN</option>
                        <option value="oidc">OIDC workload identity</option>
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400 mb-1">Auth Source DB</div>
                      <VarInput
                        value={parsedCfg?.auth?.authSource ?? ''}
                        onChange={v => patchAuth({ authSource: v })}
                        placeholder="admin"
                        variableSuggestions={variableSuggestions ?? []}
                      />
                    </div>
                  </div>
                  {(!parsedCfg?.auth?.mode || parsedCfg.auth.mode === 'scram' || parsedCfg.auth.mode === 'ldap-plain') && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs text-slate-400 mb-1">Username</div>
                        <VarInput
                          value={parsedCfg?.auth?.username ?? ''}
                          onChange={v => patchAuth({ username: v })}
                          placeholder="{{mongoUser}}"
                          variableSuggestions={variableSuggestions ?? []}
                        />
                      </div>
                      <div>
                        <div className="text-xs text-slate-400 mb-1">Password</div>
                        <VarInput
                          value={parsedCfg?.auth?.password ?? ''}
                          onChange={v => patchAuth({ password: v })}
                          placeholder="{{mongoPassword}}"
                          variableSuggestions={variableSuggestions ?? []}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        )}

        {/* PRE-REQUEST */}
        {activeTab === 'Pre-request' && (
          <ScriptTab
            key={activeTabId + '-mongo-pre'}
            label={<>JavaScript runs before the request. Use <code className="text-orange-400">apx.environment.set("key", "value")</code></>}
            value={preRequestScript}
            onChange={onPreRequestChange}
            onSyntaxCheck={onPreRequestSyntaxCheck}
            placeholder={`// Pre-request script\napx.environment.set('timestamp', Date.now().toString());`}
            target="prerequest"
            requestNames={requestNames}
            requestItems={requestItems}
            rows={10}
            className="p-3"
          />
        )}

        {/* TESTS */}
        {activeTab === 'Tests' && (
          <ScriptTab
            key={activeTabId + '-mongo-test'}
            label={<>JavaScript runs after the response. Use <code className="text-orange-400">apx.test()</code> and <code className="text-orange-400">apx.expect()</code></>}
            value={testScript}
            onChange={onTestChange}
            onSyntaxCheck={onTestSyntaxCheck}
            placeholder={`apx.test("Has results", () => {\n  const json = apx.response.json();\n  apx.expect(json).to.be.an('array');\n});`}
            target="test"
            requestNames={requestNames}
            requestItems={requestItems}
            rows={10}
            className="p-3"
          />
        )}

        {/* DOCS */}
        {activeTab === 'Docs' && (
          <div className="flex flex-col gap-3 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500">Add notes for this request. Supports Markdown.</p>
              <div className="flex rounded overflow-hidden border border-slate-600 text-xs">
                <button
                  onClick={() => setDocsMode('edit')}
                  className={`px-3 py-1 transition-colors ${docsMode === 'edit' ? 'bg-slate-600 text-slate-100' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                >Edit</button>
                <button
                  onClick={() => setDocsMode('preview')}
                  className={`px-3 py-1 transition-colors ${docsMode === 'preview' ? 'bg-slate-600 text-slate-100' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                >Preview</button>
              </div>
            </div>
            {docsMode === 'edit' ? (
              <textarea
                value={description}
                onChange={e => onDescriptionChange(e.target.value)}
                rows={8}
                spellCheck={false}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                placeholder={'# My Request\n\nDescribe what this request does, its parameters, and expected responses.'}
              />
            ) : (
              <div
                className="markdown-preview bg-slate-900 border border-slate-600 rounded px-4 py-3 min-h-[120px] text-sm text-slate-200 overflow-auto"
                dangerouslySetInnerHTML={{ __html: description ? marked.parse(description) as string : '<p class="text-slate-600 italic">Nothing to preview.</p>' }}
              />
            )}
          </div>
        )}

      </div>
    </div>
  );
}
