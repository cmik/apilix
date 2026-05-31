import { useState } from 'react';
import { useApp, generateId } from '../store';
import type { DatabaseConnection } from '../types';
import { useDatabaseConnectionActions } from '../hooks/useDatabaseConnectionActions';
import { IconSearch } from './Icons';
import ConfirmModal from './ConfirmModal';
import {
  buildDatabaseConnectionsExportPackage,
  makeDuplicateConnection,
} from '../utils/databaseConnectionTransfer';

interface DatabaseListModeProps {
  onEdit: (conn: DatabaseConnection) => void;
}

function methodBadge(type: string): string {
  if (type === 'mysql') return 'text-blue-400 bg-blue-400/15';
  if (type === 'postgres') return 'text-sky-400 bg-sky-400/15';
  if (type === 'mongodb') return 'text-green-400 bg-green-400/15';
  if (type === 'sqlite') return 'text-amber-400 bg-amber-400/15';
  if (type === 'redis') return 'text-red-400 bg-red-400/15';
  if (type === 'cassandra') return 'text-cyan-400 bg-cyan-400/15';
  if (type === 'dynamodb') return 'text-emerald-400 bg-emerald-400/15';
  if (type === 'oracle') return 'text-yellow-400 bg-yellow-400/15';
  if (type === 'mssql') return 'text-indigo-400 bg-indigo-400/15';
  return 'text-slate-400 bg-slate-400/15';
}

function methodLabel(type: string): string {
  if (type === 'mysql') return 'MySQL';
  if (type === 'postgres') return 'PG';
  if (type === 'mongodb') return 'Mongo';
  if (type === 'sqlite') return 'SQLite';
  if (type === 'redis') return 'Redis';
  if (type === 'cassandra') return 'Cassandra';
  if (type === 'dynamodb') return 'DynamoDB';
  if (type === 'oracle') return 'Oracle';
  if (type === 'mssql') return 'MSSQL';
  return type.toUpperCase();
}

function connPreview(conn: DatabaseConnection): string {
  if (conn.type === 'mongodb') {
    const uri = (conn as any).connectionUri || '';
    try {
      const u = new URL(uri);
      return u.hostname + (u.port ? ':' + u.port : '');
    } catch {
      return uri.slice(0, 40);
    }
  }
  if (conn.type === 'sqlite') {
    return (conn as any).filePath || '';
  }
  if (conn.type === 'redis') {
    const redis = conn as any;
    if (redis.connectionUri) return redis.connectionUri.slice(0, 60);
    return `${redis.host || ''}:${redis.port || 6379}/db${redis.db ?? 0}`;
  }
  if (conn.type === 'cassandra') {
    const cass = conn as any;
    return `${(cass.contactPoints || []).join(',')}:${cass.port || 9042}`;
  }
  if (conn.type === 'dynamodb') {
    const dyn = conn as any;
    return dyn.endpoint ? `${dyn.region} @ ${dyn.endpoint}` : dyn.region;
  }
  if (conn.type === 'oracle') {
    const ora = conn as any;
    if (ora.connectString) return ora.connectString;
    return `${ora.host || ''}:${ora.port || 1521}/${ora.serviceName || ora.database || ''}`;
  }
  if (conn.type === 'mssql') {
    const ms = conn as any;
    return `${ms.host || ''}:${ms.port || 1433}/${ms.database || ''}`;
  }
  const sql = conn as any;
  return `${sql.host || ''}:${sql.port || ''}/${sql.database || ''}`;
}

const DB_TYPES = ['mysql', 'postgres', 'mongodb', 'sqlite', 'redis', 'cassandra', 'dynamodb', 'oracle', 'mssql'] as const;

export default function DatabaseListMode({ onEdit }: DatabaseListModeProps) {
  const { state, dispatch } = useApp();
  const { handleEdit, handleTest, handleDelete, handleSelect, testingId, deletingId } = useDatabaseConnectionActions(onEdit);
  
  const [textFilter, setTextFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const databases = state.databases ?? [];
  const activeDatabaseId = state.activeDatabaseId;
  const confirmDeleteConn = confirmDeleteId
    ? databases.find(d => d._id === confirmDeleteId) ?? null
    : null;

  function downloadConnection(conn: DatabaseConnection) {
    const payload = buildDatabaseConnectionsExportPackage([conn]);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = conn.name.replace(/[^a-z0-9_\-. ]/gi, '_') || 'connection';
    a.download = `apilix-db-${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function duplicateConnection(conn: DatabaseConnection) {
    const duplicated = makeDuplicateConnection(conn, databases.map(d => d.name), generateId);
    dispatch({ type: 'ADD_DATABASE', payload: duplicated });
    dispatch({ type: 'SET_ACTIVE_DATABASE', payload: duplicated._id });
  }

  function copyConnectionId(connectionId: string) {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(connectionId);
  }

  // Filter databases
  const filtered = databases.filter(conn => {
    const matchesText = !textFilter || 
      conn.name.toLowerCase().includes(textFilter.toLowerCase()) ||
      connPreview(conn).toLowerCase().includes(textFilter.toLowerCase());
    const matchesType = typeFilter === 'all' || conn.type === typeFilter;
    return matchesText && matchesType;
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-700 shrink-0 space-y-2">
        {/* Text filter */}
        <div className="relative">
          <input
            type="text"
            placeholder="Filter by name or host…"
            value={textFilter}
            onChange={e => setTextFilter(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 pl-7 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-orange-500"
          />
          <IconSearch className="absolute left-2 top-2.5 w-3 h-3 text-slate-500" />
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
        >
          <option value="all">All Types</option>
          {DB_TYPES.map(t => (
            <option key={t} value={t}>{methodLabel(t)}</option>
          ))}
        </select>
      </div>

      {/* Database list */}
      <div className="flex-1 overflow-y-auto">
        {databases.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500 px-3 py-4">
            <p className="text-xs">No connections yet</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500 px-3 py-4">
            <p className="text-xs">No connections match filter</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-800">
            {filtered.map(conn => (
              <li
                key={conn._id}
                className={`flex items-center gap-2 px-3 py-2.5 hover:bg-slate-800/50 group cursor-pointer transition-colors ${
                  activeDatabaseId === conn._id ? 'bg-orange-500/10 border-l-2 border-orange-500' : ''
                }`}
                onClick={() => handleSelect(conn._id)}
              >
                {/* Type badge */}
                <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${methodBadge(conn.type)}`}>
                  {methodLabel(conn.type)}
                </span>

                {/* Name + preview */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-slate-100 truncate">{conn.name}</p>
                  <p className="text-[11px] text-slate-500 truncate font-mono">{connPreview(conn)}</p>
                </div>

                {/* Test status */}
                {conn.testStatus === 'success' && (
                  <span className="text-[9px] text-green-400 shrink-0">● OK</span>
                )}
                {conn.testStatus === 'failed' && (
                  <span className="text-[9px] text-red-400 shrink-0 cursor-help" title={conn.testError}>● Fail</span>
                )}

                {/* Menu button */}
                <div className="relative">
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setOpenMenu(openMenu === conn._id ? null : conn._id);
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                    title="Actions menu"
                  >
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>

                  {/* Dropdown menu */}
                  {openMenu === conn._id && (
                    <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded shadow-lg z-50 min-w-[120px]">
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          handleEdit(conn);
                          setOpenMenu(null);
                        }}
                        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors border-b border-slate-700"
                      >
                        Edit
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          handleTest(conn);
                          setOpenMenu(null);
                        }}
                        disabled={testingId === conn._id}
                        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors border-b border-slate-700 disabled:opacity-50"
                      >
                        {testingId === conn._id ? 'Testing…' : 'Test'}
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setConfirmDeleteId(conn._id);
                          setOpenMenu(null);
                        }}
                        disabled={deletingId === conn._id}
                        className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-slate-700 hover:text-red-300 transition-colors border-b border-slate-700 disabled:opacity-50"
                      >
                        {deletingId === conn._id ? 'Deleting…' : 'Delete'}
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          duplicateConnection(conn);
                          setOpenMenu(null);
                        }}
                        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors border-b border-slate-700"
                      >
                        Duplicate
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          copyConnectionId(conn._id);
                          setOpenMenu(null);
                        }}
                        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors border-b border-slate-700"
                      >
                        Copy ID
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          downloadConnection(conn);
                          setOpenMenu(null);
                        }}
                        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors"
                      >
                        Export
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Delete confirmation modal */}
      {confirmDeleteConn && (
        <ConfirmModal
          title="Delete connection?"
          message={<>Delete connection <strong className="text-slate-200">{confirmDeleteConn.name}</strong>? This cannot be undone.</>}
          confirmLabel={deletingId === confirmDeleteConn._id ? 'Deleting…' : 'Delete'}
          danger={true}
          onConfirm={() => {
            void handleDelete(confirmDeleteConn);
            setConfirmDeleteId(null);
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}
