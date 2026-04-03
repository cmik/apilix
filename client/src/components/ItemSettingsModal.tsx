import { useState } from 'react';
import { marked } from 'marked';
import type { PostmanAuth, PostmanEvent } from '../types';

type AuthType = PostmanAuth['type'];
const SUPPORTED_AUTH: AuthType[] = ['noauth', 'bearer', 'basic', 'apikey'];

interface Props {
  kind: 'collection' | 'folder';
  name: string;
  auth?: PostmanAuth;
  event?: PostmanEvent[];
  description?: string;
  onSave: (auth: PostmanAuth | undefined, event: PostmanEvent[], description: string) => void;
  onClose: () => void;
}

function getScript(events: PostmanEvent[] | undefined, listen: 'prerequest' | 'test'): string {
  const ev = (events || []).find(e => e.listen === listen);
  if (!ev) return '';
  const exec = ev.script.exec;
  return Array.isArray(exec) ? exec.join('\n') : (exec as string);
}

function patchEvents(
  events: PostmanEvent[] | undefined,
  listen: 'prerequest' | 'test',
  code: string,
): PostmanEvent[] {
  const others = (events || []).filter(e => e.listen !== listen);
  if (!code.trim()) return others;
  return [...others, { listen, script: { type: 'text/javascript', exec: code.split('\n') } }];
}

export default function ItemSettingsModal({ kind, name, auth, event, description: initialDescription, onSave, onClose }: Props) {
  const initialAuthType: AuthType = SUPPORTED_AUTH.includes(auth?.type ?? 'noauth')
    ? (auth?.type ?? 'noauth')
    : 'noauth';

  const [activeTab, setActiveTab] = useState<'auth' | 'prerequest' | 'tests' | 'docs'>('auth');
  const [authType, setAuthType] = useState<AuthType>(initialAuthType);
  const [authBearer, setAuthBearer] = useState((auth?.bearer ?? []).find(b => b.key === 'token')?.value ?? '');
  const [authBasicUser, setAuthBasicUser] = useState((auth?.basic ?? []).find(b => b.key === 'username')?.value ?? '');
  const [authBasicPass, setAuthBasicPass] = useState((auth?.basic ?? []).find(b => b.key === 'password')?.value ?? '');
  const [authApiKeyName, setAuthApiKeyName] = useState((auth?.apikey ?? []).find(b => b.key === 'key')?.value ?? 'X-API-Key');
  const [authApiKeyValue, setAuthApiKeyValue] = useState((auth?.apikey ?? []).find(b => b.key === 'value')?.value ?? '');
  const [preScript, setPreScript] = useState(getScript(event, 'prerequest'));
  const [testScript, setTestScript] = useState(getScript(event, 'test'));
  const [description, setDescription] = useState(initialDescription ?? '');
  const [docsMode, setDocsMode] = useState<'edit' | 'preview'>('edit');

  function buildAuth(): PostmanAuth | undefined {
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
    return { type: authType };
  }

  function handleSave() {
    let events = event ? [...event] : [];
    events = patchEvents(events, 'prerequest', preScript);
    events = patchEvents(events, 'test', testScript);
    onSave(buildAuth(), events, description);
    onClose();
  }

  const TABS = [
    { key: 'auth' as const, label: 'Authorization' },
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
                  <option value="noauth">No Auth</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="basic">Basic Auth</option>
                  <option value="apikey">API Key</option>
                </select>
              </div>
              {authType === 'bearer' && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Token</label>
                  <input
                    value={authBearer}
                    onChange={e => setAuthBearer(e.target.value)}
                    placeholder="{{token}}"
                    className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                  />
                </div>
              )}
              {authType === 'basic' && (
                <div className="flex flex-col gap-2">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Username</label>
                    <input value={authBasicUser} onChange={e => setAuthBasicUser(e.target.value)}
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
                    <input value={authApiKeyName} onChange={e => setAuthApiKeyName(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Value</label>
                    <input value={authApiKeyValue} onChange={e => setAuthApiKeyValue(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Pre-request Script ── */}
          {activeTab === 'prerequest' && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-slate-400">Runs before every request in this {kind}.</p>
              <textarea
                value={preScript}
                onChange={e => setPreScript(e.target.value)}
                rows={16}
                spellCheck={false}
                className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                placeholder={"// pm.environment.set('token', pm.response.json().token);"}
              />
            </div>
          )}

          {/* ── Tests ── */}
          {activeTab === 'tests' && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-slate-400">Runs after every request in this {kind}.</p>
              <textarea
                value={testScript}
                onChange={e => setTestScript(e.target.value)}
                rows={16}
                spellCheck={false}
                className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                placeholder={"// pm.test('Status 200', () => pm.expect(pm.response.code).to.equal(200));"}
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
