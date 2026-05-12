import { useMemo, useState } from 'react';
import { marked } from 'marked';
import type { VariableSuggestion } from '../utils/variableAutocomplete';
import type { DatabaseConnection, SqlDialect } from '../types';
import VarInput from './VarInput';
import CodeEditor from './CodeEditor';
import ScriptTab from './ScriptTab';

type MainTab = 'Connection' | 'Query' | 'Pre-request' | 'Tests' | 'Docs';

type SqlMethod = 'MYSQL' | 'POSTGRESQL';

interface SqlRequestConfigState {
  connectionId: string;
  dialect: SqlDialect;
  query: string;
  params: string;
  resultView: 'table' | 'json';
}

const DEFAULT_QUERY: Record<SqlMethod, string> = {
  MYSQL: 'SELECT NOW() AS server_time;',
  POSTGRESQL: 'SELECT NOW() AS server_time;',
};

function defaultConfig(method: SqlMethod): SqlRequestConfigState {
  return {
    connectionId: '',
    dialect: method === 'POSTGRESQL' ? 'postgres' : 'mysql',
    query: DEFAULT_QUERY[method],
    params: '[]',
    resultView: 'table',
  };
}

function parseConfig(raw: string, method: SqlMethod): SqlRequestConfigState {
  if (!raw || !raw.trim()) return defaultConfig(method);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultConfig(method);
    const dialect = parsed.dialect === 'postgres' || parsed.dialect === 'mysql'
      ? parsed.dialect
      : (method === 'POSTGRESQL' ? 'postgres' : 'mysql');
    return {
      connectionId: typeof parsed.connectionId === 'string' ? parsed.connectionId : '',
      dialect,
      query: typeof parsed.query === 'string' ? parsed.query : DEFAULT_QUERY[method],
      params: typeof parsed.params === 'string' ? parsed.params : '[]',
      resultView: parsed.resultView === 'json' ? 'json' : 'table',
    };
  } catch {
    return defaultConfig(method);
  }
}

interface SqlRequestPanelProps {
  method: SqlMethod;
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
  databases: DatabaseConnection[];
  onBodyChange: (v: string) => void;
  onPreRequestChange: (v: string) => void;
  onTestChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onPreRequestSyntaxCheck: (hasError: boolean) => void;
  onTestSyntaxCheck: (hasError: boolean) => void;
}

export default function SqlRequestPanel({
  method,
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
  databases,
  onBodyChange,
  onPreRequestChange,
  onTestChange,
  onDescriptionChange,
  onPreRequestSyntaxCheck,
  onTestSyntaxCheck,
}: SqlRequestPanelProps) {
  const [activeTab, setActiveTab] = useState<MainTab>('Query');
  const [docsMode, setDocsMode] = useState<'edit' | 'preview'>('edit');

  const cfg = useMemo(() => parseConfig(bodyRaw, method), [bodyRaw, method]);

  function updateConfig(patch: Partial<SqlRequestConfigState>) {
    const next = { ...cfg, ...patch };
    onBodyChange(JSON.stringify(next, null, 2));
  }

  const supportedConnections = useMemo(
    () => databases.filter(db => db.type === (method === 'POSTGRESQL' ? 'postgres' : 'mysql')),
    [databases, method],
  );

  const TABS: Array<{ id: MainTab; hasError?: boolean }> = [
    { id: 'Connection' },
    { id: 'Query' },
    { id: 'Pre-request', hasError: preRequestHasError && !!preRequestScript.trim() },
    { id: 'Tests', hasError: testHasError && !!testScript.trim() },
    { id: 'Docs' },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
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

      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'Connection' && (
          <div className="p-3 flex flex-col gap-3">
            <div>
              <p className="text-xs text-slate-400 mb-1">Database Connection</p>
              {supportedConnections.length > 0 ? (
                <select
                  value={cfg.connectionId}
                  onChange={e => updateConfig({ connectionId: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
                >
                  <option value="">Select a saved connection</option>
                  {supportedConnections.map(conn => (
                    <option key={conn._id} value={conn._id}>{conn.name}</option>
                  ))}
                </select>
              ) : (
                <VarInput
                  value={cfg.connectionId}
                  onChange={v => updateConfig({ connectionId: v })}
                  placeholder="connection id (or {{sqlConnectionId}})"
                  variableSuggestions={variableSuggestions}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 font-mono focus:outline-none focus:border-orange-500"
                />
              )}
              <p className="text-[10px] text-slate-600 mt-1">Use saved database connections from the Databases settings panel.</p>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-1">Result View</p>
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input
                    type="radio"
                    checked={cfg.resultView === 'table'}
                    onChange={() => updateConfig({ resultView: 'table' })}
                    className="accent-orange-500"
                  />
                  Table (default)
                </label>
                <label className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input
                    type="radio"
                    checked={cfg.resultView === 'json'}
                    onChange={() => updateConfig({ resultView: 'json' })}
                    className="accent-orange-500"
                  />
                  JSON
                </label>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'Query' && (
          <div className="p-3 flex flex-col gap-3">
            <div>
              <p className="text-xs text-slate-400 mb-1">SQL Query</p>
              <CodeEditor
                value={cfg.query}
                onChange={e => updateConfig({ query: e.target.value })}
                language="text"
                rows={10}
                variableSuggestions={variableSuggestions}
                placeholder={DEFAULT_QUERY[method]}
              />
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-1">Query Params (JSON array)</p>
              <CodeEditor
                value={cfg.params}
                onChange={e => updateConfig({ params: e.target.value })}
                language="json"
                rows={4}
                variableSuggestions={variableSuggestions}
                placeholder='[] or ["{{userId}}", 10]'
              />
            </div>
          </div>
        )}

        {activeTab === 'Pre-request' && (
          <ScriptTab
            key={activeTabId + '-sql-pre'}
            label={<>JavaScript runs before the request. Use <code className="text-orange-400">apx.environment.set("key", "value")</code></>}
            value={preRequestScript}
            onChange={onPreRequestChange}
            onSyntaxCheck={onPreRequestSyntaxCheck}
            placeholder={`// Pre-request script\napx.environment.set('limit', '100');`}
            target="prerequest"
            requestNames={requestNames}
            requestItems={requestItems}
            rows={10}
            className="p-3"
          />
        )}

        {activeTab === 'Tests' && (
          <ScriptTab
            key={activeTabId + '-sql-test'}
            label={<>JavaScript runs after the response. Use <code className="text-orange-400">apx.test()</code> and <code className="text-orange-400">apx.expect()</code></>}
            value={testScript}
            onChange={onTestChange}
            onSyntaxCheck={onTestSyntaxCheck}
            placeholder={`apx.test("Query returned rows", () => {\n  const json = apx.response.json();\n  apx.expect(json.rowCount).to.be.above(0);\n});`}
            target="test"
            requestNames={requestNames}
            requestItems={requestItems}
            rows={10}
            className="p-3"
          />
        )}

        {activeTab === 'Docs' && (
          <div className="p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500">Add notes for this SQL request. Supports Markdown.</p>
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
              <CodeEditor
                value={description}
                onChange={e => onDescriptionChange(e.target.value)}
                language="text"
                rows={8}
                placeholder="Document what this query validates, expected row shape, and dependencies."
              />
            ) : (
              <div className="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 prose prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-li:my-0">
                <div dangerouslySetInnerHTML={{ __html: marked.parse(description || '*No documentation yet.*') as string }} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
