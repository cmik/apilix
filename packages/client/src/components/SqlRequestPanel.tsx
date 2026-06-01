import { useMemo, useState } from 'react';
import { marked } from 'marked';
import type { DatabaseConnection, DatabaseRequestConfig, SqlDatabaseType, SqlDialect } from '../types';
import type { VariableSuggestion } from '../utils/variableAutocomplete';
import VarInput from './VarInput';
import CodeEditor from './CodeEditor';
import ScriptTab from './ScriptTab';

type MainTab = 'Connection' | 'Query' | 'Pre-request' | 'Tests' | 'Docs';
type DatabaseMethod = 'MYSQL' | 'POSTGRESQL' | 'SQLITE' | 'CASSANDRA' | 'ORACLE' | 'MSSQL' | 'REDIS' | 'DYNAMODB';
type SqlMethod = Extract<DatabaseMethod, 'MYSQL' | 'POSTGRESQL' | 'SQLITE' | 'CASSANDRA' | 'ORACLE' | 'MSSQL'>;

const DEFAULT_QUERY: Record<SqlMethod, string> = {
  MYSQL: 'SELECT NOW() AS server_time;',
  POSTGRESQL: 'SELECT NOW() AS server_time;',
  SQLITE: 'SELECT datetime("now") AS server_time;',
  CASSANDRA: 'SELECT now() AS server_time FROM system.local;',
  ORACLE: 'SELECT CURRENT_TIMESTAMP AS server_time FROM dual',
  MSSQL: 'SELECT SYSDATETIME() AS server_time;',
};

const DYNAMO_OPERATIONS = ['GetItem', 'PutItem', 'UpdateItem', 'DeleteItem', 'Query', 'Scan'] as const;

function isSqlMethod(method: DatabaseMethod): method is SqlMethod {
  return ['MYSQL', 'POSTGRESQL', 'SQLITE', 'CASSANDRA', 'ORACLE', 'MSSQL'].includes(method);
}

function databaseTypeForMethod(method: DatabaseMethod): DatabaseRequestConfig['databaseType'] {
  switch (method) {
    case 'MYSQL': return 'mysql';
    case 'POSTGRESQL': return 'postgres';
    case 'SQLITE': return 'sqlite';
    case 'CASSANDRA': return 'cassandra';
    case 'ORACLE': return 'oracle';
    case 'MSSQL': return 'mssql';
    case 'REDIS': return 'redis';
    case 'DYNAMODB': return 'dynamodb';
  }
}

function isSqlConfig(cfg: DatabaseRequestConfig): cfg is Extract<DatabaseRequestConfig, { databaseType: SqlDatabaseType }> {
  return ['mysql', 'postgres', 'sqlite', 'cassandra', 'oracle', 'mssql'].includes(cfg.databaseType);
}

function isRedisConfig(cfg: DatabaseRequestConfig): cfg is Extract<DatabaseRequestConfig, { databaseType: 'redis' }> {
  return cfg.databaseType === 'redis';
}

function isDynamoConfig(cfg: DatabaseRequestConfig): cfg is Extract<DatabaseRequestConfig, { databaseType: 'dynamodb' }> {
  return cfg.databaseType === 'dynamodb';
}

function defaultConfig(method: DatabaseMethod): DatabaseRequestConfig {
  if (isSqlMethod(method)) {
    const databaseType = databaseTypeForMethod(method) as SqlDatabaseType;
    return {
      connectionId: '',
      databaseType,
      operation: 'query',
      dialect: databaseType as SqlDialect,
      query: DEFAULT_QUERY[method],
      params: '[]',
      resultView: 'table',
    };
  }
  if (method === 'REDIS') {
    return {
      connectionId: '',
      databaseType: 'redis',
      operation: 'command',
      command: 'PING',
      args: '[]',
      resultView: 'json',
    };
  }
  return {
    connectionId: '',
    databaseType: 'dynamodb',
    operation: 'Scan',
    input: '{\n  "TableName": ""\n}',
    resultView: 'json',
  };
}

function parseConfig(raw: string, method: DatabaseMethod): DatabaseRequestConfig {
  const fallback = defaultConfig(method);
  if (!raw || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return { ...fallback, ...parsed, databaseType: databaseTypeForMethod(method) } as DatabaseRequestConfig;
  } catch {
    return fallback;
  }
}

interface SqlRequestPanelProps {
  method: DatabaseMethod;
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

  function updateConfig(patch: Partial<DatabaseRequestConfig>) {
    const next = { ...cfg, ...patch, databaseType: databaseTypeForMethod(method) } as DatabaseRequestConfig;
    onBodyChange(JSON.stringify(next, null, 2));
  }

  const supportedConnections = useMemo(
    () => databases.filter(db => db.type === databaseTypeForMethod(method)),
    [databases, method],
  );

  const queryTabLabel = method === 'REDIS' ? 'Command' : method === 'DYNAMODB' ? 'Operation' : 'Query';
  const docsLabel = method === 'REDIS' ? 'Redis command' : method === 'DYNAMODB' ? 'DynamoDB operation' : 'database request';

  const tabs: Array<{ id: MainTab; label?: string; hasError?: boolean }> = [
    { id: 'Connection' },
    { id: 'Query', label: queryTabLabel },
    { id: 'Pre-request', hasError: preRequestHasError && !!preRequestScript.trim() },
    { id: 'Tests', hasError: testHasError && !!testScript.trim() },
    { id: 'Docs' },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex border-b border-slate-700 bg-slate-800 shrink-0">
        {tabs.map(({ id, label, hasError }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`relative px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === id
                ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label || id}
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
                  placeholder={`connection id (or {{${databaseTypeForMethod(method)}ConnectionId}})`}
                  variableSuggestions={variableSuggestions}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 font-mono focus:outline-none focus:border-orange-500"
                />
              )}
              <p className="text-[10px] text-slate-600 mt-1">Use saved database connections from the Databases panel.</p>
            </div>

            {isSqlMethod(method) ? (
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
            ) : (
              <div className="text-xs text-slate-500">Responses are shown as JSON for this database type.</div>
            )}
          </div>
        )}

        {activeTab === 'Query' && isSqlMethod(method) && isSqlConfig(cfg) && (
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
                value={cfg.params || '[]'}
                onChange={e => updateConfig({ params: e.target.value })}
                language="json"
                rows={4}
                variableSuggestions={variableSuggestions}
                placeholder='[] or ["{{userId}}", 10]'
              />
            </div>
          </div>
        )}

        {activeTab === 'Query' && method === 'REDIS' && isRedisConfig(cfg) && (
          <div className="p-3 flex flex-col gap-3">
            <div>
              <p className="text-xs text-slate-400 mb-1">Redis Command</p>
              <VarInput
                value={cfg.command || ''}
                onChange={v => updateConfig({ command: v, operation: 'command' })}
                placeholder="PING"
                variableSuggestions={variableSuggestions}
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
              />
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-1">Arguments (JSON array)</p>
              <CodeEditor
                value={cfg.args || '[]'}
                onChange={e => updateConfig({ args: e.target.value })}
                language="json"
                rows={5}
                variableSuggestions={variableSuggestions}
                placeholder='[] or ["my-key", "{{value}}"]'
              />
            </div>
          </div>
        )}

        {activeTab === 'Query' && method === 'DYNAMODB' && isDynamoConfig(cfg) && (
          <div className="p-3 flex flex-col gap-3">
            <div>
              <p className="text-xs text-slate-400 mb-1">Operation</p>
              <select
                value={cfg.operation}
                onChange={e => updateConfig({ operation: e.target.value as typeof DYNAMO_OPERATIONS[number] })}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
              >
                {DYNAMO_OPERATIONS.map(operation => (
                  <option key={operation} value={operation}>{operation}</option>
                ))}
              </select>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-1">Input (JSON object)</p>
              <CodeEditor
                value={cfg.input || '{\n  "TableName": ""\n}'}
                onChange={e => updateConfig({ input: e.target.value })}
                language="json"
                rows={10}
                variableSuggestions={variableSuggestions}
                placeholder='{"TableName":"Users"}'
              />
            </div>
          </div>
        )}

        {activeTab === 'Pre-request' && (
          <ScriptTab
            key={activeTabId + '-db-pre'}
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
            key={activeTabId + '-db-test'}
            label={<>JavaScript runs after the response. Use <code className="text-orange-400">apx.test()</code> and <code className="text-orange-400">apx.expect()</code></>}
            value={testScript}
            onChange={onTestChange}
            onSyntaxCheck={onTestSyntaxCheck}
            placeholder={isSqlMethod(method)
              ? `apx.test("Query returned rows", () => {\n  const json = apx.response.json();\n  apx.expect(json.rowCount).to.be.above(0);\n});`
              : `apx.test("Command succeeded", () => {\n  const json = apx.response.json();\n  apx.expect(json.result).to.exist;\n});`}
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
              <p className="text-xs text-slate-500">Add notes for this {docsLabel}. Supports Markdown.</p>
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
                rows={16}
                spellCheck={false}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                placeholder={`# ${docsLabel}\n\nDocument what this request does and what response shape it expects.`}
              />
            ) : (
              <div
                className="markdown-preview bg-slate-900 border border-slate-600 rounded px-4 py-3 min-h-[200px] text-sm text-slate-200 overflow-auto"
                dangerouslySetInnerHTML={{ __html: description ? marked.parse(description) as string : '<p class="text-slate-600 italic">Nothing to preview.</p>' }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
