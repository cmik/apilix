import { useState, useEffect } from 'react';
import {
  listMongoConnections,
  saveMongoConnection,
  deleteMongoConnection,
  testMongoConnection,
  type MongoConnectionSummary,
} from '../utils/mongoConnections';

interface EditingConnection extends MongoConnectionSummary {
  uri?: string; // Not returned from API, only used during edit
}

interface Props {
  onClose?: () => void;
}

type FormAuthMode = 'none' | 'scram' | 'x509' | 'ldap' | 'oidc';

function normalizeAuthMode(mode: string | undefined): FormAuthMode {
  if (mode === 'scram' || mode === 'x509' || mode === 'ldap' || mode === 'oidc') return mode;
  if (mode === 'ldap-plain') return 'ldap';
  return 'none';
}

export default function MongoConnectionManager({ onClose }: Props) {
  const [connections, setConnections] = useState<EditingConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingConnection | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
const [testResult, setTestResult] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string } | undefined>>({});

  // Form fields
  const [formName, setFormName] = useState('');
  const [formUri, setFormUri] = useState('');
  const [formDb, setFormDb] = useState('');
  const [formAuthMode, setFormAuthMode] = useState<FormAuthMode>('none');
  const [formError, setFormError] = useState<string | null>(null);

  // Load connections on mount
  useEffect(() => {
    (async () => {
      try {
        const list = await listMongoConnections();
        setConnections(list);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to load MongoDB connections',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function startEdit(conn: EditingConnection | null) {
    if (!conn) {
      // New connection
      setEditing({ id: '', name: '', database: '', authMode: 'none', hasUri: false });
      setFormName('');
      setFormUri('');
      setFormDb('');
      setFormAuthMode('none');
    } else {
      // Edit existing
      setEditing(conn);
      setFormName(conn.name);
      setFormUri(conn.uri ?? '');
      setFormDb(conn.database);
      setFormAuthMode(normalizeAuthMode(conn.authMode));
    }
    setFormError(null);
  }

  function cancelEdit() {
    setEditing(null);
    setFormError(null);
  }

  async function saveEdit() {
    if (!formName.trim()) {
      setFormError('Name is required');
      return;
    }
    if (!formUri.trim()) {
      setFormError('Connection URI is required');
      return;
    }
    if (!formDb.trim()) {
      setFormError('Database name is required');
      return;
    }

    try {
      setFormError(null);
      const id = editing?.id || crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      await saveMongoConnection({
        id,
        name: formName.trim(),
        uri: formUri.trim(),
        database: formDb.trim(),
        authMode: formAuthMode,
      });

      // Reload list and clear any stale test result for this connection
      const updated = await listMongoConnections();
      setConnections(updated);
      setTestResult(prev => { const next = { ...prev }; delete next[id]; return next; });
      setEditing(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save connection');
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await deleteMongoConnection(deleting);
      const updated = await listMongoConnections();
      setConnections(updated);
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete connection');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-sm text-slate-400">Loading connections…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded bg-red-900/40 border border-red-700/60">
          <svg className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <span className="text-xs text-red-300 break-all">{error}</span>
        </div>
      )}

      {/* List of connections */}
      {!editing && (
        <div>
          {connections.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-slate-400 mb-4">No MongoDB connections saved yet.</p>
              <button
                onClick={() => startEdit(null)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add connection
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {connections.map(conn => (
                <div
                  key={conn.id}
                  className="flex items-center justify-between gap-3 p-3 bg-slate-800 border border-slate-700 rounded hover:border-slate-600 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-200">{conn.name}</div>
                    <div className="text-xs text-slate-400 truncate">
                      {conn.database}
                      {conn.authMode !== 'none' && ` • ${conn.authMode.toUpperCase()}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {conn.hasUri && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-700/60">
                        ✓ URI set
                      </span>
                    )}
                    <button
                      onClick={async () => {
                        setTesting(conn.id);
                        setTestResult(prev => ({ ...prev, [conn.id]: undefined }));
                        try {
                          const res = await testMongoConnection(conn.id);
                          setTestResult(prev => ({ ...prev, [conn.id]: res }));
                        } catch (err) {
                          setTestResult(prev => ({ ...prev, [conn.id]: { ok: false, error: err instanceof Error ? err.message : 'Test failed' } }));
                        } finally {
                          setTesting(null);
                        }
                      }}
                      disabled={testing === conn.id}
                      className="px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors disabled:opacity-50"
                      title="Test connection"
                    >
                      {testing === conn.id ? '…' : 'Test'}
                    </button>
                    {testResult[conn.id] !== undefined && (() => {
                      const tr = testResult[conn.id]!;
                      return (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tr.ok ? 'bg-green-900/40 text-green-400 border-green-700/60' : 'bg-red-900/40 text-red-400 border-red-700/60'}`}
                          title={tr.error || `${tr.latencyMs}ms`}
                        >
                          {tr.ok ? `✓ ${tr.latencyMs}ms` : '✗ failed'}
                        </span>
                      );
                    })()}
                    <button
                      onClick={() => startEdit(conn)}
                      className="px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleting(conn.id)}
                      className="px-2 py-1 text-xs rounded bg-slate-700 hover:bg-red-700/60 border border-slate-600 text-slate-300 hover:text-red-300 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              <button
                onClick={() => startEdit(null)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors mt-2"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add connection
              </button>
            </div>
          )}
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="p-4 bg-slate-800 border border-slate-700 rounded space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Name</label>
            <input
              type="text"
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder="e.g., Production MongoDB"
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Connection URI</label>
            <input
              type="password"
              value={formUri}
              onChange={e => setFormUri(e.target.value)}
              placeholder="mongodb+srv://user:pass@cluster.mongodb.net"
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500 transition-colors"
            />
            <p className="text-[10px] text-slate-500 mt-1">
              URI is stored encrypted and never sent from the app.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Default Database</label>
            <input
              type="text"
              value={formDb}
              onChange={e => setFormDb(e.target.value)}
              placeholder="myapp"
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Authentication Mode</label>
            <select
              value={formAuthMode}
              onChange={e => setFormAuthMode(e.target.value as typeof formAuthMode)}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500 transition-colors"
            >
              <option value="none">None</option>
              <option value="scram">SCRAM-SHA-256 (in URI)</option>
              <option value="x509">X.509 Certificate</option>
              <option value="ldap">LDAP</option>
              <option value="oidc">OIDC</option>
            </select>
            <p className="text-[10px] text-slate-500 mt-1">
              Credentials should be embedded in the URI (e.g., <span className="font-mono">mongodb://user:pass@host</span>) or use authSource parameter.
            </p>
          </div>

          {formError && (
            <div className="p-2 rounded bg-red-900/40 border border-red-700/60">
              <p className="text-xs text-red-300">{formError}</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={cancelEdit}
              className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={saveEdit}
              className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors"
            >
              {editing.id ? 'Update' : 'Create'} Connection
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleting && (
        <div className="p-3 rounded bg-red-900/40 border border-red-700/60 space-y-2">
          <p className="text-sm text-red-300">
            Delete this connection? Requests using it will need a new connection assigned.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setDeleting(null)}
              className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              className="px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white font-medium transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
