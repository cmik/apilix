import { useState } from 'react';
import { useApp } from '../store';
import type { TestResult } from '../types';

const RESPONSE_TABS = ['Body', 'Headers', 'Test Results'] as const;
type RespTab = typeof RESPONSE_TABS[number];

function StatusBadge({ status }: { status: number }) {
  const color =
    status >= 500 ? 'bg-red-700 text-red-100' :
    status >= 400 ? 'bg-yellow-700 text-yellow-100' :
    status >= 300 ? 'bg-blue-700 text-blue-100' :
    status >= 200 ? 'bg-green-700 text-green-100' :
    'bg-slate-600 text-slate-300';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold ${color}`}>{status}</span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TestResultRow({ result }: { result: TestResult }) {
  return (
    <div className={`flex items-start gap-2 py-1.5 px-2 rounded ${result.passed ? 'bg-green-900/20' : 'bg-red-900/20'}`}>
      <span className={`text-sm shrink-0 ${result.passed ? 'text-green-400' : 'text-red-400'}`}>
        {result.passed ? '✓' : '✗'}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${result.passed ? 'text-green-200' : 'text-red-200'}`}>{result.name}</p>
        {!result.passed && result.error && (
          <p className="text-xs text-red-400 mt-0.5 font-mono break-all">{result.error}</p>
        )}
      </div>
    </div>
  );
}

function tryPrettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export default function ResponseViewer() {
  const { state } = useApp();
  const [tab, setTab] = useState<RespTab>('Body');
  const [rawMode, setRawMode] = useState(false);

  const { response, isLoading } = state;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 border-t border-slate-700 bg-slate-900">
        <div className="text-slate-400 text-sm flex items-center gap-2">
          <span className="animate-pulse">⏳</span> Sending request...
        </div>
      </div>
    );
  }

  if (!response) {
    return (
      <div className="flex items-center justify-center h-32 border-t border-slate-700 bg-slate-900">
        <p className="text-slate-600 text-sm">Hit Send to see the response</p>
      </div>
    );
  }

  const passed = response.testResults.filter(t => t.passed).length;
  const failed = response.testResults.filter(t => !t.passed).length;

  return (
    <div className="border-t border-slate-700 bg-slate-900 flex flex-col" style={{ minHeight: '260px', maxHeight: '50vh' }}>
      {/* Response status bar */}
      <div className="flex items-center gap-4 px-3 py-2 border-b border-slate-700 shrink-0">
        {response.error ? (
          <span className="text-red-400 text-sm font-medium">⚠ {response.error}</span>
        ) : (
          <>
            <StatusBadge status={response.status} />
            <span className="text-slate-400 text-xs">{response.statusText}</span>
            <span className="text-slate-500 text-xs">{response.responseTime} ms</span>
            <span className="text-slate-500 text-xs">{formatSize(response.size)}</span>
          </>
        )}
        {/* Test summary badge */}
        {response.testResults.length > 0 && (
          <span className={`ml-auto text-xs px-2 py-0.5 rounded font-medium ${
            failed > 0 ? 'bg-red-800 text-red-200' : 'bg-green-800 text-green-200'
          }`}>
            Tests: {passed}/{response.testResults.length} passed
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 shrink-0">
        {RESPONSE_TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              tab === t
                ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'Test Results'
              ? `Tests ${response.testResults.length > 0 ? `(${passed}/${response.testResults.length})` : ''}`
              : t}
          </button>
        ))}
        {tab === 'Body' && (
          <div className="ml-auto flex items-center gap-2 pr-3">
            <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer">
              <input
                type="checkbox"
                checked={rawMode}
                onChange={e => setRawMode(e.target.checked)}
                className="accent-orange-500"
              />
              Raw
            </label>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {tab === 'Body' && (
          <pre className="p-3 text-sm font-mono text-slate-200 whitespace-pre-wrap break-all">
            {rawMode ? response.body : tryPrettyJson(response.body)}
          </pre>
        )}

        {tab === 'Headers' && (
          <div className="p-3">
            {Object.entries(response.headers).length === 0 ? (
              <p className="text-slate-500 text-sm">No headers</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(response.headers).map(([k, v]) => (
                    <tr key={k} className="border-b border-slate-800">
                      <td className="py-1 pr-4 text-slate-400 font-medium w-1/3">{k}</td>
                      <td className="py-1 text-slate-200 font-mono break-all">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'Test Results' && (
          <div className="p-3 flex flex-col gap-1">
            {response.testResults.length === 0 ? (
              <p className="text-slate-500 text-sm">No tests ran. Add test scripts in the Tests tab.</p>
            ) : (
              response.testResults.map((r, i) => <TestResultRow key={i} result={r} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}
