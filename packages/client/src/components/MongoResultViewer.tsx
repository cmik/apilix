import { useMemo, useState } from 'react';
import type { MongoQueryResult } from '../types';

interface MongoResultViewerProps {
  result: MongoQueryResult;
}

export default function MongoResultViewer({ result }: MongoResultViewerProps) {
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  const isArray = useMemo(() => Array.isArray(result.data), [result.data]);
  const rows = useMemo((): Record<string, unknown>[] => (isArray ? (result.data as Record<string, unknown>[]) : []), [result.data, isArray]);
  const columns = useMemo(() => {
    const colSet = new Set<string>();
    if (isArray && rows.length > 0) {
      rows.forEach((row: Record<string, unknown>) => {
        if (typeof row === 'object' && row !== null) {
          Object.keys(row).forEach((key) => colSet.add(key));
        }
      });
    }
    return Array.from(colSet).slice(0, 20); // Limit to 20 columns
  }, [rows, isArray]);

  const toggleRow = (index: number) => {
    const next = new Set(expandedRows);
    next.has(index) ? next.delete(index) : next.add(index);
    setExpandedRows(next);
  };

  if (!result.success) {
    return (
      <div className="h-full flex flex-col bg-slate-750 border border-slate-700 rounded">
        <div className="flex-1 overflow-auto p-4">
          <div className="text-red-400 text-sm font-mono whitespace-pre-wrap break-words">
            {result.error || 'Query failed'}
          </div>
        </div>
      </div>
    );
  }

  if (!isArray || rows.length === 0) {
    return (
      <div className="h-full flex flex-col bg-slate-750 border border-slate-700 rounded">
        <div className="flex-1 overflow-auto p-4">
          <div className="text-slate-400 text-xs">No documents found</div>
        </div>
        <div className="border-t border-slate-700 px-4 py-2 text-xs text-slate-400">
          Execution time: {result.executionTime}ms | Documents: {result.documentCount || 0}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-750 border border-slate-700 rounded overflow-hidden">
      {/* Header with tabs */}
      <div className="flex gap-2 border-b border-slate-700 px-4 py-2 bg-slate-800">
        <button
          onClick={() => setViewMode('table')}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            viewMode === 'table'
              ? 'bg-orange-600 text-white'
              : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          Table
        </button>
        <button
          onClick={() => setViewMode('json')}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            viewMode === 'json'
              ? 'bg-orange-600 text-white'
              : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          JSON
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {viewMode === 'table' ? (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-slate-800">
              <tr className="border-b border-slate-700">
                <th className="w-12 px-3 py-2 text-left text-slate-400 font-medium border-r border-slate-700"></th>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2 text-left text-slate-300 font-medium border-r border-slate-700 truncate"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row: Record<string, unknown>, idx: number) => (
                <tr key={idx} className="border-b border-slate-700 hover:bg-slate-700/30 group">
                  <td className="w-12 px-3 py-2 text-slate-400 border-r border-slate-700">
                    <button
                      onClick={() => toggleRow(idx)}
                      className="text-slate-500 hover:text-slate-300 text-xs cursor-pointer"
                      title="Expand row"
                    >
                      {expandedRows.has(idx) ? '▼' : '▶'}
                    </button>
                  </td>
                  {columns.map((col) => {
                    const val = typeof row === 'object' && row !== null ? row[col] : null;
                    const displayVal =
                      val === null ? <span className="text-slate-500">null</span> :
                      typeof val === 'string' ? val :
                      typeof val === 'boolean' ? String(val) :
                      typeof val === 'object' ? JSON.stringify(val) :
                      String(val);
                    return (
                      <td
                        key={col}
                        className="px-3 py-2 text-slate-300 border-r border-slate-700 truncate max-w-xs"
                      >
                        {displayVal}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="p-4 font-mono text-slate-300 whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(rows, null, 2)}
          </pre>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-slate-700 px-4 py-2 text-xs text-slate-400 bg-slate-800">
        Execution time: {result.executionTime}ms | Documents: {result.documentCount || 0}
        {columns.length > 20 && ' | (showing first 20 columns)'}
      </div>
    </div>
  );
}
