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
import { resolveVariables } from '../utils/variableResolver';

// ─── Types ────────────────────────────────────────────────────────────────────

type MainTab = 'Connection' | 'Query' | 'Pre-request' | 'Tests' | 'Docs';

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
  onBodyChange: (v: string) => void;
  onPreRequestChange: (v: string) => void;
  onTestChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onPreRequestSyntaxCheck: (hasError: boolean) => void;
  onTestSyntaxCheck: (hasError: boolean) => void;
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

  // Resolve auth override — only pass it if at least mode is set
  const rawAuth = parsedCfg?.auth;
  const resolvedAuth = rawAuth?.mode ? {
    mode: rawAuth.mode,
    username: rawAuth.username ? resolveVariables(rawAuth.username, resolvedVars) : undefined,
    password: rawAuth.password ? resolveVariables(rawAuth.password, resolvedVars) : undefined,
    authSource: rawAuth.authSource ? resolveVariables(rawAuth.authSource, resolvedVars) : undefined,
  } : undefined;

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
                        onChange={e => patchAuth({ mode: e.target.value })}
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
