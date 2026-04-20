import { useState, useRef, useCallback } from 'react';
import { marked } from 'marked';
import type { CollectionAuth, CollectionEvent, CollectionVariable, OAuth2Config } from '../types';
import ScriptSnippetsLibrary from './ScriptSnippetsLibrary';
import ScriptEditor from './ScriptEditor';
import OAuthConfigPanel from './OAuthConfigPanel';
import { API_BASE } from '../api';
import { openAuthorizationWindow } from '../utils/oauth';
import VarInput from './VarInput';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

type AuthType = CollectionAuth['type'];
const SUPPORTED_AUTH: AuthType[] = ['inherit', 'noauth', 'bearer', 'basic', 'apikey', 'oauth2'];

interface Props {
  kind: 'collection' | 'folder';
  name: string;
  auth?: CollectionAuth;
  event?: CollectionEvent[];
  description?: string;
  variables?: CollectionVariable[];
  requestNames?: string[];
  requestItems?: Array<{ id: string; name: string }>;
  onSave: (auth: CollectionAuth | undefined, event: CollectionEvent[], description: string, variables: CollectionVariable[]) => void;
  onClose: () => void;
  variableSuggestions?: VariableSuggestion[];
}

function getScript(events: CollectionEvent[] | undefined, listen: 'prerequest' | 'test'): string {
  const ev = (events || []).find(e => e.listen === listen);
  if (!ev) return '';
  const exec = ev.script.exec;
  return Array.isArray(exec) ? exec.join('\n') : (exec as string);
}

function patchEvents(
  events: CollectionEvent[] | undefined,
  listen: 'prerequest' | 'test',
  code: string,
): CollectionEvent[] {
  const others = (events || []).filter(e => e.listen !== listen);
  if (!code.trim()) return others;
  return [...others, { listen, script: { type: 'text/javascript', exec: code.split('\n') } }];
}

export default function ItemSettingsModal({ kind, name, auth, event, description: initialDescription, variables: initialVariables, requestNames, requestItems, onSave, onClose, variableSuggestions }: Props) {
  const initialAuthType: AuthType = SUPPORTED_AUTH.includes(auth?.type ?? 'noauth')
    ? (auth?.type ?? (kind === 'folder' ? 'inherit' : 'noauth'))
    : (kind === 'folder' ? 'inherit' : 'noauth');

  const [activeTab, setActiveTab] = useState<'auth' | 'variables' | 'prerequest' | 'tests' | 'docs'>('auth');
  const [authType, setAuthType] = useState<AuthType>(initialAuthType);
  const [authBearer, setAuthBearer] = useState((auth?.bearer ?? []).find(b => b.key === 'token')?.value ?? '');
  const [authBasicUser, setAuthBasicUser] = useState((auth?.basic ?? []).find(b => b.key === 'username')?.value ?? '');
  const [authBasicPass, setAuthBasicPass] = useState((auth?.basic ?? []).find(b => b.key === 'password')?.value ?? '');
  const [authApiKeyName, setAuthApiKeyName] = useState((auth?.apikey ?? []).find(b => b.key === 'key')?.value ?? 'X-API-Key');
  const [authApiKeyValue, setAuthApiKeyValue] = useState((auth?.apikey ?? []).find(b => b.key === 'value')?.value ?? '');
  const [authOAuth2Config, setAuthOAuth2Config] = useState<OAuth2Config>(auth?.oauth2 ?? {
    grantType: 'authorization_code',
    clientId: '',
    clientSecret: '',
    tokenUrl: '',
  });
  const [isRefreshingToken, setIsRefreshingToken] = useState(false);
  const [isGettingAuthCode, setIsGettingAuthCode] = useState(false);
  const [preScript, setPreScript] = useState(getScript(event, 'prerequest'));
  const [testScript, setTestScript] = useState(getScript(event, 'test'));
  const [description, setDescription] = useState(initialDescription ?? '');
  const [docsMode, setDocsMode] = useState<'edit' | 'preview'>('edit');
  const [vars, setVars] = useState<CollectionVariable[]>(initialVariables ?? []);

  const preScriptRef = useRef<HTMLTextAreaElement>(null);
  const testScriptRef = useRef<HTMLTextAreaElement>(null);

  const handlePreInsert = useCallback((code: string) => {
    const el = preScriptRef.current;
    if (!el) {
      setPreScript(prev => prev ? prev + '\n\n' + code : code);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const separator = (preScript.length > 0 && !preScript.endsWith('\n')) ? '\n\n' : (preScript.length > 0 ? '\n' : '');
    const before = preScript.slice(0, start);
    const after = preScript.slice(end);
    const newValue = before + (start === end && start === preScript.length ? separator : '') + code + after;
    setPreScript(newValue);
    // Restore focus and move cursor after inserted snippet
    requestAnimationFrame(() => {
      const insertPos = start + (start === end && start === preScript.length ? separator.length : 0) + code.length;
      el.focus();
      el.setSelectionRange(insertPos, insertPos);
    });
  }, [preScript]);

  const handleTestInsert = useCallback((code: string) => {
    const el = testScriptRef.current;
    if (!el) {
      setTestScript(prev => prev ? prev + '\n\n' + code : code);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const separator = (testScript.length > 0 && !testScript.endsWith('\n')) ? '\n\n' : (testScript.length > 0 ? '\n' : '');
    const before = testScript.slice(0, start);
    const after = testScript.slice(end);
    const newValue = before + (start === end && start === testScript.length ? separator : '') + code + after;
    setTestScript(newValue);
    // Restore focus and move cursor after inserted snippet
    requestAnimationFrame(() => {
      const insertPos = start + (start === end && start === testScript.length ? separator.length : 0) + code.length;
      el.focus();
      el.setSelectionRange(insertPos, insertPos);
    });
  }, [testScript]);

  function buildAuth(): CollectionAuth | undefined {
    if (authType === 'inherit') return undefined;
    if (authType === 'noauth') return { type: 'noauth' };
    if (authType === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: authBearer, type: 'string' }] };
    if (authType === 'basic') return {
      type: 'basic',
      basic: [
        { key: 'username', value: authBasicUser, type: 'string' },
        { key: 'password', value: authBasicPass, type: 'string' },
      ],
    };
    if (authType === 'apikey') return {
      type: 'apikey',
      apikey: [
        { key: 'key', value: authApiKeyName, type: 'string' },
        { key: 'value', value: authApiKeyValue, type: 'string' },
      ],
    };
    if (authType === 'oauth2') return {
      type: 'oauth2',
      oauth2: authOAuth2Config,
    };
    return { type: authType };
  }

  async function handleGetAuthorizationCode() {
    const config = authOAuth2Config;
    if (!config.authorizationUrl || !config.clientId || !config.tokenUrl) {
      window.alert('Missing required fields: Authorization URL, Client ID, or Token URL');
      return;
    }
    setIsGettingAuthCode(true);
    try {
      const result = await openAuthorizationWindow(
        config.authorizationUrl,
        config.clientId,
        config.redirectUrl || 'http://localhost:3000/oauth/callback',
        config.scopes || []
      );
      if (!result) {
        window.alert('Authorization was cancelled or the popup was blocked.');
        return;
      }
      const response = await fetch(`${API_BASE}/oauth/exchange-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oauth2Config: { ...config },
          authorizationCode: result.code,
          codeVerifier: result.codeVerifier,
          environment: {},
        }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to exchange authorization code');
      }
      const { accessToken, refreshToken, expiresAt } = await response.json();
      setAuthOAuth2Config(prev => ({
        ...prev,
        accessToken,
        ...(refreshToken && { refreshToken }),
        expiresAt,
        codeVerifier: undefined,
      }));
      window.alert('Authorization successful! Token has been obtained.');
    } catch (err) {
      window.alert(`Failed to get authorization code: ${(err as Error).message}`);
    } finally {
      setIsGettingAuthCode(false);
    }
  }

  async function handleRefreshOAuthToken() {
    const config = authOAuth2Config;
    if (!config.tokenUrl || !config.clientId) {
      window.alert('Missing required fields: Token URL or Client ID');
      return;
    }
    setIsRefreshingToken(true);
    try {
      const response = await fetch(`${API_BASE}/oauth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oauth2Config: config, environment: {} }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to refresh token');
      }
      const { accessToken, refreshToken, expiresAt } = await response.json();
      setAuthOAuth2Config(prev => ({
        ...prev,
        accessToken,
        ...(refreshToken && { refreshToken }),
        expiresAt,
      }));
      window.alert('Token refreshed successfully!');
    } catch (err) {
      window.alert(`Failed to refresh token: ${(err as Error).message}`);
    } finally {
      setIsRefreshingToken(false);
    }
  }

  function handleSave() {
    let events = event ? [...event] : [];
    events = patchEvents(events, 'prerequest', preScript);
    events = patchEvents(events, 'test', testScript);
    onSave(buildAuth(), events, description, vars.filter(v => v.key));
    onClose();
  }

  const TABS = [
    { key: 'auth' as const, label: 'Authorization' },
    ...(kind === 'collection' ? [{ key: 'variables' as const, label: 'Variables' }] : []),
    { key: 'prerequest' as const, label: 'Pre-request Script' },
    { key: 'tests' as const, label: 'Tests' },
    { key: 'docs' as const, label: 'Documentation' },
  ];

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-[640px] max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">
              {kind === 'collection' ? '📚 Collection' : '📁 Folder'} · Settings
            </p>
            <h2 className="text-slate-100 font-semibold text-base mt-0.5 truncate">{name}</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-2xl leading-none ml-4 p-1">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700 px-4 shrink-0">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`py-2.5 px-3 text-xs font-medium border-b-2 -mb-px transition-colors ${
                activeTab === t.key
                  ? 'border-orange-400 text-orange-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0">

          {/* ── Auth ── */}
          {activeTab === 'auth' && (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-slate-400">
                Auth configured here is inherited by all requests in this {kind} that have no explicit auth set.
              </p>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Type</label>
                <select
                  value={authType}
                  onChange={e => setAuthType(e.target.value as AuthType)}
                  className="w-48 bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                >
                  {kind === 'folder' && <option value="inherit">Inherit auth from parent</option>}
                  <option value="noauth">No Auth</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="basic">Basic Auth</option>
                  <option value="apikey">API Key</option>
                  <option value="oauth2">OAuth 2.0</option>
                </select>
              </div>
              {authType === 'bearer' && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Token</label>
                  <VarInput
                    value={authBearer}
                    onChange={v => setAuthBearer(v)}
                    placeholder="{{token}}"
                    variableSuggestions={variableSuggestions}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                  />
                </div>
              )}
              {authType === 'basic' && (
                <div className="flex flex-col gap-2">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Username</label>
                    <VarInput value={authBasicUser} onChange={v => setAuthBasicUser(v)}
                      variableSuggestions={variableSuggestions}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Password</label>
                    <input type="password" value={authBasicPass} onChange={e => setAuthBasicPass(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500" />
                  </div>
                </div>
              )}
              {authType === 'apikey' && (
                <div className="flex flex-col gap-2">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Key name</label>
                    <VarInput value={authApiKeyName} onChange={v => setAuthApiKeyName(v)}
                      variableSuggestions={variableSuggestions}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Value</label>
                    <VarInput value={authApiKeyValue} onChange={v => setAuthApiKeyValue(v)}
                      variableSuggestions={variableSuggestions}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500" />
                  </div>
                </div>
              )}
              {authType === 'oauth2' && (
                <OAuthConfigPanel
                  config={authOAuth2Config}
                  onChange={config => setAuthOAuth2Config(prev => ({ ...prev, ...config }))}
                  onRefreshToken={handleRefreshOAuthToken}
                  onGetAuthorizationCode={handleGetAuthorizationCode}
                  isRefreshing={isRefreshingToken}
                  isGettingAuthCode={isGettingAuthCode}
                  variableSuggestions={variableSuggestions}
                />
              )}
            </div>
          )}

          {/* ── Variables ── */}
          {activeTab === 'variables' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-slate-400">
                Collection variables are available to all requests in this collection via <code className="text-orange-400 font-mono">{'{{key}}'}</code> syntax.
                They can also be read and set in scripts via <code className="text-orange-400 font-mono">apx.collection.get/set(key)</code>.
              </p>
              <div className="flex flex-col gap-1">
                {vars.map((v, i) => (
                  <div key={i} className={`flex gap-1 items-center ${v.disabled ? 'opacity-40' : ''}`}>
                    <input
                      type="checkbox"
                      checked={!v.disabled}
                      onChange={() => setVars(prev => prev.map((x, j) => j === i ? { ...x, disabled: !x.disabled } : x))}
                      className="shrink-0 accent-orange-500 cursor-pointer"
                      title={v.disabled ? 'Enable' : 'Disable'}
                    />
                    <input
                      value={v.key}
                      onChange={e => setVars(prev => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                      placeholder="Variable name"
                      className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                    />
                    <VarInput
                      value={v.value}
                      onChange={val => setVars(prev => prev.map((x, j) => j === i ? { ...x, value: val } : x))}
                      placeholder="value"
                      variableSuggestions={variableSuggestions}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                    />
                    <button
                      onClick={() => setVars(prev => prev.filter((_, j) => j !== i))}
                      className="text-slate-600 hover:text-red-400 transition-colors px-1 text-lg leading-none shrink-0"
                      title="Remove"
                    >×</button>
                  </div>
                ))}
                <button
                  onClick={() => setVars(prev => [...prev, { key: '', value: '' }])}
                  className="self-start mt-1 text-xs text-orange-400 hover:text-orange-300 transition-colors"
                >
                  + Add variable
                </button>
              </div>
            </div>
          )}

          {/* ── Pre-request Script ── */}
          {activeTab === 'prerequest' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-slate-400">Runs before every request in this {kind}.</p>
                <ScriptSnippetsLibrary target="prerequest" onInsert={handlePreInsert} />
              </div>
              <ScriptEditor
                textareaRef={preScriptRef}
                value={preScript}
                onChange={setPreScript}
                onSave={handleSave}
                rows={16}
                placeholder={"// apx.environment.set('token', 'value');"}
                requestNames={requestNames}
                requestItems={requestItems}
              />
            </div>
          )}

          {/* ── Tests ── */}
          {activeTab === 'tests' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-slate-400">Runs after every request in this {kind}.</p>
                <ScriptSnippetsLibrary target="test" onInsert={handleTestInsert} />
              </div>
              <ScriptEditor
                textareaRef={testScriptRef}
                value={testScript}
                onChange={setTestScript}
                onSave={handleSave}
                rows={16}
                placeholder={"// apx.test('Status 200', () => apx.expect(apx.response.code).to.equal(200));"}
                requestNames={requestNames}
                requestItems={requestItems}
              />
            </div>
          )}

          {/* ── Documentation ── */}
          {activeTab === 'docs' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-400">Add notes or documentation for this {kind}. Supports Markdown.</p>
                <div className="flex rounded overflow-hidden border border-slate-600 text-xs">
                  <button
                    onClick={() => setDocsMode('edit')}
                    className={`px-3 py-1 transition-colors ${docsMode === 'edit' ? 'bg-slate-600 text-slate-100' : 'bg-slate-700 text-slate-400 hover:text-slate-200'}`}
                  >Edit</button>
                  <button
                    onClick={() => setDocsMode('preview')}
                    className={`px-3 py-1 transition-colors ${docsMode === 'preview' ? 'bg-slate-600 text-slate-100' : 'bg-slate-700 text-slate-400 hover:text-slate-200'}`}
                  >Preview</button>
                </div>
              </div>
              {docsMode === 'edit' ? (
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                  placeholder={'# My Collection\n\nDescribe what this collection contains and how to use it.'}
                />
              ) : (
                <div
                  className="markdown-preview bg-slate-800 border border-slate-600 rounded px-4 py-3 min-h-[200px] text-sm text-slate-200 overflow-auto"
                  // Content is always user-authored, never from external sources
                  dangerouslySetInnerHTML={{ __html: description ? marked.parse(description) as string : '<p class="text-slate-600 italic">Nothing to preview.</p>' }}
                />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-700 shrink-0">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors rounded">
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded font-medium transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
