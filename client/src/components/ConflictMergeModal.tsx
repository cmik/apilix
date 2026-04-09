/**
 * ConflictMergeModal — three-pane merge review UI.
 *
 * Layout:
 *  Left  — conflict navigator (grouped by domain, unresolved badge)
 *  Center — local vs remote side-by-side with base hints
 *  Right  — merged preview (live JSON)
 *
 * Actions per conflict:
 *  Take Local | Take Remote | Edit (free-form textarea in merged preview)
 *
 * Footer:
 *  Keep All Local | Keep All Remote | Apply Merged (enabled when 0 unresolved)
 */

import { useState, useMemo, useCallback } from 'react';
import type { ConflictPackage, MergeConflictNode, WorkspaceData, AppCollection, AppEnvironment, CollectionItem, MockRoute } from '../types';

interface ConflictMergeModalProps {
  conflictPackage: ConflictPackage;
  onResolved: (merged: WorkspaceData, resolvedConflicts: MergeConflictNode[]) => void;
  onKeepLocal: () => void;
  onKeepRemote: () => void;
  onClose: () => void;
}

const DOMAIN_LABELS: Record<string, string> = {
  request: 'Requests',
  collection: 'Collections',
  environment: 'Environments',
  globalVariables: 'Global Variables',
  collectionVariables: 'Collection Variables',
  mockRoute: 'Mock Routes',
};

const KIND_LABELS: Record<string, string> = {
  'field-overlap': 'Field conflict',
  'move-vs-edit': 'Move vs edit',
  'delete-vs-edit': 'Delete vs edit',
  'rename-vs-rename': 'Rename conflict',
  'json-conflict': 'JSON key conflict',
  'json-parse-fallback': 'Text merge conflict',
};

export default function ConflictMergeModal({
  conflictPackage,
  onResolved,
  onKeepLocal,
  onKeepRemote,
  onClose,
}: ConflictMergeModalProps) {
  const { mergeResult } = conflictPackage;
  const initialConflicts = mergeResult.conflicts;

  // Mutable resolution state: map conflictId → resolved value
  const [resolutions, setResolutions] = useState<Map<string, string>>(
    () => new Map(initialConflicts.filter(c => c.resolved).map(c => [c.id, c.resolved!]))
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConflicts.length > 0 ? initialConflicts[0].id : null
  );
  const [filterUnresolved, setFilterUnresolved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const unresolvedCount = useMemo(
    () => initialConflicts.filter(c => !resolutions.has(c.id)).length,
    [initialConflicts, resolutions],
  );

  const visibleConflicts = useMemo(() => {
    if (!filterUnresolved) return initialConflicts;
    return initialConflicts.filter(c => !resolutions.has(c.id));
  }, [initialConflicts, resolutions, filterUnresolved]);

  const grouped = useMemo(() => {
    const map = new Map<string, MergeConflictNode[]>();
    for (const c of visibleConflicts) {
      const group = map.get(c.domain) ?? [];
      group.push(c);
      map.set(c.domain, group);
    }
    return map;
  }, [visibleConflicts]);

  const selected = initialConflicts.find(c => c.id === selectedId) ?? null;

  function resolve(id: string, value: string) {
    setResolutions(prev => new Map(prev).set(id, value));
    setDirty(true);
  }

  function unresolve(id: string) {
    setResolutions(prev => {
      const m = new Map(prev);
      m.delete(id);
      return m;
    });
    setDirty(true);
  }

  function takeLocal(conflict: MergeConflictNode) {
    resolve(conflict.id, conflict.local);
    advanceToNextUnresolved(conflict.id);
  }

  function takeRemote(conflict: MergeConflictNode) {
    resolve(conflict.id, conflict.remote);
    advanceToNextUnresolved(conflict.id);
  }

  function startEdit(conflict: MergeConflictNode) {
    setEditingId(conflict.id);
    setEditBuffer(resolutions.get(conflict.id) ?? conflict.local);
  }

  function commitEdit() {
    if (editingId) {
      resolve(editingId, editBuffer);
      setEditingId(null);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditBuffer('');
  }

  function advanceToNextUnresolved(currentId: string) {
    const unresolved = initialConflicts.filter(c => !resolutions.has(c.id) && c.id !== currentId);
    if (unresolved.length > 0) {
      setSelectedId(unresolved[0].id);
    }
  }

  const buildMerged = useCallback((): WorkspaceData => {
    // Apply all resolutions on top of the auto-merged workspace
    const resolved: MergeConflictNode[] = initialConflicts.map(c => ({
      ...c,
      resolved: resolutions.get(c.id) ?? c.local,
    }));

    // Re-apply resolutions to the merged data by patching fields
    // The merged data already has `local` as the default for conflicts,
    // so we only need to patch fields where resolution !== local.
    const base = JSON.parse(JSON.stringify(mergeResult.merged)) as WorkspaceData;

    for (const conflict of resolved) {
      const value = conflict.resolved ?? conflict.local;
      if (value === conflict.local) continue; // already correct in merged
      applyResolution(base, conflict, value);
    }
    return base;
  }, [mergeResult.merged, initialConflicts, resolutions]);

  function handleApplyMerged() {
    const merged = buildMerged();
    const resolvedList = initialConflicts.map(c => ({
      ...c,
      resolved: resolutions.get(c.id) ?? c.local,
    }));
    onResolved(merged, resolvedList);
  }

  function handleClose() {
    if (dirty) {
      setShowCloseConfirm(true);
    } else {
      onClose();
    }
  }

  const mergedPreview = useMemo(() => {
    if (!selected) return '';
    const value = resolutions.get(selected.id);
    if (value !== undefined) return value;
    return selected.local; // unresolved defaults to local
  }, [selected, resolutions]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="relative flex flex-col bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-[96vw] max-w-7xl h-[90vh] overflow-hidden">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-white">Merge Conflicts</span>
            {unresolvedCount > 0 && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-900 text-yellow-300">
                {unresolvedCount} unresolved
              </span>
            )}
            <span className="text-xs text-slate-400">
              {mergeResult.autoMergedCount} auto-merged &middot; {initialConflicts.length} total
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-orange-500"
                checked={filterUnresolved}
                onChange={e => setFilterUnresolved(e.target.checked)}
              />
              Unresolved only
            </label>
            <button
              onClick={handleClose}
              className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0">

          {/* ── Left: Conflict navigator ──────────────────────────────────── */}
          <nav className="w-56 shrink-0 border-r border-slate-700 overflow-y-auto bg-slate-950/40">
            {[...grouped.entries()].map(([domain, items]) => (
              <div key={domain}>
                <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                  {DOMAIN_LABELS[domain] ?? domain}
                </div>
                {items.map(conflict => {
                  const isResolved = resolutions.has(conflict.id);
                  const isSelected = selectedId === conflict.id;
                  return (
                    <button
                      key={conflict.id}
                      onClick={() => setSelectedId(conflict.id)}
                      className={[
                        'w-full text-left px-3 py-2 text-xs transition-colors',
                        isSelected
                          ? 'bg-slate-700 text-white'
                          : 'text-slate-300 hover:bg-slate-800',
                      ].join(' ')}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={[
                            'shrink-0 w-1.5 h-1.5 rounded-full',
                            isResolved ? 'bg-green-500' : 'bg-yellow-400',
                          ].join(' ')}
                        />
                        <span className="truncate" title={conflict.label}>
                          {conflict.label}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-500 ml-3">
                        {KIND_LABELS[conflict.kind] ?? conflict.kind}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
            {visibleConflicts.length === 0 && (
              <div className="px-3 py-8 text-xs text-slate-500 text-center">
                {filterUnresolved ? 'All resolved!' : 'No conflicts'}
              </div>
            )}
          </nav>

          {/* ── Center / Right: Diff view + merged preview ─────────────────── */}
          {selected ? (
            <div className="flex flex-1 min-w-0 divide-x divide-slate-700">

              {/* Local */}
              <DiffPane
                title="Local"
                accentClass="border-blue-500"
                value={selected.local}
                base={selected.base}
                actionLabel="Take Local"
                onAction={() => takeLocal(selected)}
                isActive={!resolutions.has(selected.id) || resolutions.get(selected.id) === selected.local}
              />

              {/* Remote */}
              <DiffPane
                title="Remote"
                accentClass="border-orange-500"
                value={selected.remote}
                base={selected.base}
                actionLabel="Take Remote"
                onAction={() => takeRemote(selected)}
                isActive={resolutions.get(selected.id) === selected.remote}
              />

              {/* Merged preview */}
              <div className="flex flex-col flex-1 min-w-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-800/50 shrink-0">
                  <span className="text-xs font-medium text-slate-300">Merged</span>
                  <div className="flex gap-1">
                    {editingId === selected.id ? (
                      <>
                        <button
                          onClick={commitEdit}
                          className="px-2 py-0.5 rounded text-xs bg-green-700 text-white hover:bg-green-600"
                        >
                          Apply
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="px-2 py-0.5 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => startEdit(selected)}
                          className="px-2 py-0.5 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600"
                        >
                          Edit
                        </button>
                        {resolutions.has(selected.id) && (
                          <button
                            onClick={() => unresolve(selected.id)}
                            className="px-2 py-0.5 rounded text-xs bg-slate-700 text-slate-400 hover:text-white"
                          >
                            Reset
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-auto">
                  {editingId === selected.id ? (
                    <textarea
                      className="w-full h-full bg-slate-950 text-slate-200 text-xs font-mono p-3 resize-none outline-none"
                      value={editBuffer}
                      onChange={e => setEditBuffer(e.target.value)}
                      spellCheck={false}
                      autoFocus
                    />
                  ) : (
                    <pre className="p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap break-words">
                      {mergedPreview || <span className="text-slate-500 italic">(empty)</span>}
                    </pre>
                  )}
                </div>
                <div className="px-3 py-1.5 border-t border-slate-700 bg-slate-800/40 shrink-0">
                  {resolutions.has(selected.id) ? (
                    <span className="text-xs text-green-400">✓ Resolved</span>
                  ) : (
                    <span className="text-xs text-yellow-400">⚠ Unresolved — defaults to local</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-slate-500 text-sm">
              Select a conflict on the left to review
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 bg-slate-800/50 shrink-0">
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (window.confirm('Keep all local changes and discard remote? This cannot be undone.')) {
                  onKeepLocal();
                }
              }}
              className="px-3 py-1.5 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
            >
              Keep All Local
            </button>
            <button
              onClick={() => {
                if (window.confirm('Apply all remote changes and discard local? This cannot be undone.')) {
                  onKeepRemote();
                }
              }}
              className="px-3 py-1.5 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
            >
              Keep All Remote
            </button>
          </div>
          <div className="flex items-center gap-3">
            {unresolvedCount > 0 && (
              <span className="text-xs text-yellow-400">{unresolvedCount} unresolved (will default to local)</span>
            )}
            <button
              onClick={handleApplyMerged}
              className="px-4 py-1.5 rounded text-xs font-semibold bg-orange-500 text-white hover:bg-orange-400 transition-colors disabled:opacity-40"
            >
              Apply Merged
            </button>
          </div>
        </div>
      </div>

      {/* ── Close confirm dialog ─────────────────────────────────────────── */}
      {showCloseConfirm && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
          <div className="bg-slate-800 border border-slate-600 rounded-lg p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-slate-200 mb-4">
              You have unsaved resolutions. Close anyway?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCloseConfirm(false)}
                className="px-3 py-1.5 text-xs rounded bg-slate-700 text-slate-300 hover:bg-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowCloseConfirm(false); onClose(); }}
                className="px-3 py-1.5 text-xs rounded bg-red-700 text-white hover:bg-red-600"
              >
                Discard & Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DiffPane helper component ────────────────────────────────────────────────

interface DiffPaneProps {
  title: string;
  accentClass: string;
  value: string;
  base: string | null;
  actionLabel: string;
  onAction: () => void;
  isActive: boolean;
}

function DiffPane({ title, accentClass, value, base, actionLabel, onAction, isActive }: DiffPaneProps) {
  const [showBase, setShowBase] = useState(false);
  const display = showBase ? (base ?? '(no base)') : value;

  return (
    <div className={['flex flex-col flex-1 min-w-0 border-l-2', accentClass].join(' ')}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-800/50 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-300">{title}</span>
          {base !== null && (
            <button
              onClick={() => setShowBase(v => !v)}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
              title="Toggle base"
            >
              {showBase ? 'Hide base' : 'Show base'}
            </button>
          )}
        </div>
        <button
          onClick={onAction}
          className={[
            'px-2 py-0.5 rounded text-xs transition-colors font-medium',
            isActive
              ? 'bg-orange-500 text-white hover:bg-orange-400'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
          ].join(' ')}
        >
          {isActive ? '✓ ' : ''}{actionLabel}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <pre className={[
          'p-3 text-xs font-mono whitespace-pre-wrap break-words',
          showBase ? 'text-slate-400' : 'text-slate-200',
        ].join(' ')}>
          {display || <span className="text-slate-500 italic">(empty)</span>}
        </pre>
      </div>
    </div>
  );
}

// ─── Merge resolution patcher ─────────────────────────────────────────────────

/**
 * Apply a user-chosen resolution value back into the merged WorkspaceData.
 * Handles all conflict domains.
 */
function applyResolution(
  data: WorkspaceData,
  conflict: MergeConflictNode,
  value: string,
): void {
  const parsed = tryParseJson(value);

  switch (conflict.domain) {
    case 'collection': {
      if (!parsed) return;
      const idx = data.collections.findIndex(c => c._id === conflict.id);
      if (idx >= 0) data.collections[idx] = parsed as AppCollection;
      return;
    }
    case 'environment': {
      if (conflict.id.includes('#')) {
        // Variable key within environment: env_id#varKey
        const [envId, varKey] = conflict.id.split('#');
        const env = data.environments.find(e => e._id === envId);
        if (env) {
          const vi = env.values.findIndex(v => v.key === varKey);
          if (vi >= 0) env.values[vi].value = value;
          else env.values.push({ key: varKey, value, enabled: true });
        }
      } else if (parsed) {
        const idx = data.environments.findIndex(e => e._id === conflict.id);
        if (idx >= 0) data.environments[idx] = parsed as AppEnvironment;
      }
      return;
    }
    case 'globalVariables': {
      const key = conflict.id.replace('global#', '');
      data.globalVariables[key] = value;
      return;
    }
    case 'collectionVariables': {
      const [colId, varKey] = conflict.id.split('#');
      if (!data.collectionVariables[colId]) data.collectionVariables[colId] = {};
      data.collectionVariables[colId][varKey] = value;
      return;
    }
    case 'request': {
      // Could be body, script, or full item
      if (conflict.id.endsWith('#body')) {
        const itemId = conflict.id.replace('#body', '');
        patchBodyInCollections(data.collections, itemId, value);
      } else if (conflict.id.endsWith('#prerequest') || conflict.id.endsWith('#test')) {
        const parts = conflict.id.split('#');
        const listen = parts[parts.length - 1] as 'prerequest' | 'test';
        const itemId = parts.slice(0, -1).join('#');
        patchScriptInCollections(data.collections, itemId, listen, value);
      } else if (parsed) {
        patchItemInCollections(data.collections, conflict.id, parsed as CollectionItem);
      }
      return;
    }
    case 'mockRoute': {
      if (!parsed) return;
      const idx = data.mockRoutes.findIndex(r => r.id === conflict.id);
      if (idx >= 0) data.mockRoutes[idx] = parsed as MockRoute;
      return;
    }
  }
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function patchBodyInCollections(
  collections: WorkspaceData['collections'],
  itemId: string,
  body: string,
): void {
  for (const col of collections) {
    if (patchBodyInItems(col.item ?? [], itemId, body)) return;
  }
}

function patchBodyInItems(items: import('../types').CollectionItem[], itemId: string, body: string): boolean {
  for (const item of items) {
    if ((item.id ?? item.name) === itemId) {
      if (item.request?.body) item.request.body.raw = body;
      return true;
    }
    if (item.item && patchBodyInItems(item.item, itemId, body)) return true;
  }
  return false;
}

function patchScriptInCollections(
  collections: WorkspaceData['collections'],
  itemId: string,
  listen: 'prerequest' | 'test',
  exec: string,
): void {
  for (const col of collections) {
    if (patchScriptInItems(col.item ?? [], itemId, listen, exec)) return;
  }
}

function patchScriptInItems(
  items: import('../types').CollectionItem[],
  itemId: string,
  listen: 'prerequest' | 'test',
  exec: string,
): boolean {
  for (const item of items) {
    if ((item.id ?? item.name) === itemId) {
      const existing = item.event ?? [];
      const idx = existing.findIndex(e => e.listen === listen);
      const ev: import('../types').CollectionEvent = {
        listen,
        script: { type: 'text/javascript', exec: exec.split('\n') },
      };
      if (idx >= 0) existing[idx] = ev;
      else existing.push(ev);
      item.event = existing;
      return true;
    }
    if (item.item && patchScriptInItems(item.item, itemId, listen, exec)) return true;
  }
  return false;
}

function patchItemInCollections(
  collections: WorkspaceData['collections'],
  itemId: string,
  newItem: import('../types').CollectionItem,
): void {
  for (const col of collections) {
    if (patchItemInItems(col.item ?? [], itemId, newItem)) return;
  }
}

function patchItemInItems(
  items: import('../types').CollectionItem[],
  itemId: string,
  newItem: import('../types').CollectionItem,
): boolean {
  for (let i = 0; i < items.length; i++) {
    if ((items[i].id ?? items[i].name) === itemId) {
      items[i] = newItem;
      return true;
    }
    if (items[i].item && patchItemInItems(items[i].item!, itemId, newItem)) return true;
  }
  return false;
}
