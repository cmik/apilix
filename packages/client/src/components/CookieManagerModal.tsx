import { useState, useEffect, useRef } from 'react';
import { useApp, generateId } from '../store';
import type { Cookie } from '../types';
import { IconClose, IconDelete, IconPlus } from './Icons';

interface EditingCookie extends Cookie {
  _tempId: string;
}

function blankCookie(domain: string): EditingCookie {
  return {
    _tempId: generateId(),
    name: '',
    value: '',
    domain,
    path: '/',
    expires: null,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
    enabled: true,
  };
}

export default function CookieManagerModal({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useApp();
  const domains = Object.keys(state.cookieJar).sort();
  const [selectedDomain, setSelectedDomain] = useState<string>(domains[0] ?? '');
  const [newDomain, setNewDomain] = useState('');
  const [addingDomain, setAddingDomain] = useState(false);
  const [editRows, setEditRows] = useState<EditingCookie[]>([]);
  const newDomainRef = useRef<HTMLInputElement>(null);

  // When selected domain changes, sync editRows from store
  useEffect(() => {
    if (selectedDomain && state.cookieJar[selectedDomain]) {
      setEditRows(
        state.cookieJar[selectedDomain].map(c => ({ ...c, _tempId: generateId() }))
      );
    } else {
      setEditRows([]);
    }
  }, [selectedDomain, state.cookieJar]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function updateRow(tempId: string, field: keyof Cookie, val: unknown) {
    setEditRows(rows => rows.map(r => r._tempId === tempId ? { ...r, [field]: val } : r));
  }

  function deleteRow(tempId: string) {
    setEditRows(rows => rows.filter(r => r._tempId !== tempId));
  }

  function addRow() {
    setEditRows(rows => [...rows, blankCookie(selectedDomain)]);
  }

  function saveRows() {
    if (!selectedDomain) return;
    const cookies: Cookie[] = editRows
      .filter(r => r.name.trim())
      .map(({ _tempId: _id, ...c }) => c);
    dispatch({ type: 'UPSERT_DOMAIN_COOKIES', payload: { domain: selectedDomain, cookies } });
    // Remove cookies no longer in editRows (deleted ones)
    const keepNames = new Set(cookies.map(c => c.name));
    (state.cookieJar[selectedDomain] ?? []).forEach(c => {
      if (!keepNames.has(c.name)) {
        dispatch({ type: 'DELETE_COOKIE', payload: { domain: selectedDomain, name: c.name } });
      }
    });
  }

  function clearDomain(domain: string) {
    dispatch({ type: 'CLEAR_DOMAIN_COOKIES', payload: domain });
    if (selectedDomain === domain) {
      const remaining = domains.filter(d => d !== domain);
      setSelectedDomain(remaining[0] ?? '');
    }
  }

  function confirmAddDomain() {
    const d = newDomain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!d) return;
    setSelectedDomain(d);
    setNewDomain('');
    setAddingDomain(false);
    // The domain will appear once we save a cookie into it
    setEditRows([blankCookie(d)]);
  }

  const totalCount = Object.values(state.cookieJar).reduce((s, cs) => s + cs.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 flex flex-col w-full max-w-3xl bg-slate-900 border border-slate-700 rounded-lg shadow-2xl"
        style={{ maxHeight: '80vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-white">Cookie Manager</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {totalCount} cookie{totalCount !== 1 ? 's' : ''} across {domains.length} domain{domains.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 px-1"
          >
            <IconClose className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Domain list */}
          <div className="w-48 shrink-0 border-r border-slate-700 flex flex-col">
            <div className="px-3 py-2 border-b border-slate-700 shrink-0">
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">Domains</p>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {domains.length === 0 && !addingDomain && (
                <p className="text-xs text-slate-600 italic px-3 py-4 text-center">No domains yet</p>
              )}
              {domains.map(domain => (
                <div
                  key={domain}
                  className={`group flex items-center justify-between px-3 py-1.5 cursor-pointer text-xs rounded mx-1 ${
                    selectedDomain === domain
                      ? 'bg-slate-700 text-white'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                  onClick={() => { saveRows(); setSelectedDomain(domain); }}
                >
                  <span className="truncate flex-1 font-mono">{domain}</span>
                  <span className={`text-[10px] ml-1 shrink-0 ${selectedDomain === domain ? 'text-slate-400' : 'text-slate-600'}`}>
                    {(state.cookieJar[domain] ?? []).length}
                  </span>
                  <button
                    title="Clear domain cookies"
                    onClick={e => { e.stopPropagation(); clearDomain(domain); }}
                    className="ml-1 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  >
                    <IconDelete className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="px-3 py-2 border-t border-slate-700 shrink-0">
              {addingDomain ? (
                <div className="flex gap-1">
                  <input
                    ref={newDomainRef}
                    autoFocus
                    value={newDomain}
                    onChange={e => setNewDomain(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') confirmAddDomain(); if (e.key === 'Escape') { setAddingDomain(false); setNewDomain(''); } }}
                    placeholder="example.com"
                    className="flex-1 min-w-0 bg-slate-800 border border-slate-600 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none"
                  />
                  <button
                    onClick={confirmAddDomain}
                    className="px-2 py-1 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium"
                  >
                    Add
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setAddingDomain(true)}
                  className="text-xs text-slate-500 hover:text-orange-400 transition-colors flex items-center gap-1.5"
                >
                  <IconPlus className="w-3.5 h-3.5" />
                  Add domain
                </button>
              )}
            </div>
          </div>

          {/* Cookie table */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedDomain ? (
              <>
                {/* Table header */}
                <div className="grid grid-cols-[1fr_1fr_80px_60px_48px_48px_28px] gap-x-1 px-3 py-2 border-b border-slate-700 shrink-0">
                  {['Name', 'Value', 'Path', 'Expires', 'httpOnly', 'Secure', ''].map(h => (
                    <span key={h} className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">{h}</span>
                  ))}
                </div>

                {/* Rows */}
                <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
                  {editRows.length === 0 && (
                    <p className="text-xs text-slate-600 italic text-center py-6">No cookies for this domain. Add one below.</p>
                  )}
                  {editRows.map(row => (
                    <div key={row._tempId} className="grid grid-cols-[1fr_1fr_80px_60px_48px_48px_28px] gap-x-1 items-center group">
                      <input
                        value={row.name}
                        onChange={e => updateRow(row._tempId, 'name', e.target.value)}
                        placeholder="name"
                        className={`bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none w-full ${!row.enabled ? 'opacity-40' : ''}`}
                      />
                      <input
                        value={row.value}
                        onChange={e => updateRow(row._tempId, 'value', e.target.value)}
                        placeholder="value"
                        className={`bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none w-full ${!row.enabled ? 'opacity-40' : ''}`}
                      />
                      <input
                        value={row.path}
                        onChange={e => updateRow(row._tempId, 'path', e.target.value)}
                        placeholder="/"
                        className="bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none w-full"
                      />
                      <input
                        value={row.expires ?? ''}
                        onChange={e => updateRow(row._tempId, 'expires', e.target.value || null)}
                        placeholder="—"
                        title="Expires (e.g. Wed, 09 Jun 2021 10:18:14 GMT)"
                        className="bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-[10px] font-mono text-slate-200 focus:outline-none w-full"
                      />
                      <div className="flex justify-center">
                        <input
                          type="checkbox"
                          checked={row.httpOnly}
                          onChange={e => updateRow(row._tempId, 'httpOnly', e.target.checked)}
                          className="accent-orange-500"
                          title="HttpOnly"
                        />
                      </div>
                      <div className="flex justify-center">
                        <input
                          type="checkbox"
                          checked={row.secure}
                          onChange={e => updateRow(row._tempId, 'secure', e.target.checked)}
                          className="accent-orange-500"
                          title="Secure"
                        />
                      </div>
                      <button
                        onClick={() => deleteRow(row._tempId)}
                        className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-center"
                      >
                        <IconDelete className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-3 py-2 border-t border-slate-700 shrink-0">
                  <button
                    onClick={addRow}
                    className="text-xs text-slate-500 hover:text-orange-400 transition-colors flex items-center gap-1.5"
                  >
                    <IconPlus className="w-3.5 h-3.5" />
                    Add cookie
                  </button>
                  <button
                    onClick={saveRows}
                    className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors"
                  >
                    Save
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-slate-600 text-xs italic">Select or add a domain to manage cookies</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
