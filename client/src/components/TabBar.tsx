import { useState, useRef } from 'react';
import { useApp } from '../store';
import type { RequestTab } from '../types';
import { renameItemById } from '../utils/treeHelpers';

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-blue-400',
  PUT: 'text-yellow-400',
  PATCH: 'text-orange-400',
  DELETE: 'text-red-400',
  HEAD: 'text-purple-400',
  OPTIONS: 'text-slate-400',
};

interface TabBarProps {
  /** Set of tab ids that have unsaved changes (tracked by RequestBuilder) */
  dirtyIds: ReadonlySet<string>;
}

function Tab({
  tab,
  isActive,
  isDirty,
  isDragging,
  onActivate,
  onClose,
  onRename,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  tab: RequestTab;
  isActive: boolean;
  isDirty: boolean;
  isDragging: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
  onRename: (newName: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const method = tab.item.request?.method?.toUpperCase() ?? 'GET';
  const methodColor = METHOD_COLORS[method] ?? 'text-slate-400';
  const name = tab.item.name;

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  function startRename(e: React.MouseEvent) {
    e.stopPropagation();
    setRenameVal(name);
    setRenaming(true);
  }

  function commitRename() {
    const trimmed = renameVal.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    setRenaming(false);
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={renaming ? undefined : onActivate}
      className={`group relative flex items-center gap-1.5 px-3 py-0 h-full cursor-grab select-none shrink-0 border-r border-slate-800 transition-colors ${
        renaming ? 'max-w-[260px]' : 'max-w-[200px]'
      } ${isDragging ? 'opacity-40' : ''} ${
        isActive
          ? 'bg-slate-950 text-slate-100 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-orange-500'
          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
      }`}
      title={renaming ? undefined : name}
    >
      <span className={`text-[10px] font-bold shrink-0 ${methodColor}`}>{method.slice(0, 4)}</span>

      {renaming ? (
        <input
          ref={inputRef}
          autoFocus
          value={renameVal}
          onChange={e => setRenameVal(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
          }}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-slate-700 border border-orange-500 rounded px-1.5 py-0 text-xs text-slate-100 focus:outline-none"
        />
      ) : (
        <>
          <span className="truncate text-xs min-w-0 flex-1">{name}</span>

          {/* Pencil rename button */}
          <button
            onClick={startRename}
            className="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Rename"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 3.487a2.25 2.25 0 1 1 3.182 3.182L7.5 19.213l-4.5 1.318 1.318-4.5L16.862 3.487z" />
            </svg>
          </button>

          {/* Dirty dot or close button */}
          {isDirty ? (
            <span
              className="w-2 h-2 rounded-full bg-orange-400 shrink-0 group-hover:hidden"
              title="Unsaved changes"
            />
          ) : null}
          <button
            onClick={onClose}
            className={`w-4 h-4 shrink-0 rounded flex items-center justify-center text-slate-600 hover:text-slate-200 hover:bg-slate-700 transition-colors ${
              isDirty ? 'hidden group-hover:flex' : 'opacity-0 group-hover:opacity-100'
            }`}
            title="Close tab"
          >
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

export default function TabBar({ dirtyIds }: TabBarProps) {
  const { state, dispatch } = useApp();
  const { tabs, activeTabId } = state;

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [insertBefore, setInsertBefore] = useState<number | null>(null);

  if (tabs.length === 0) return null;

  function handleDragStart(e: React.DragEvent, tabId: string) {
    setDraggingId(tabId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e: React.DragEvent, tabIndex: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos = e.clientX < rect.left + rect.width / 2 ? tabIndex : tabIndex + 1;
    if (pos !== insertBefore) setInsertBefore(pos);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (draggingId === null || insertBefore === null) return;
    const fromIdx = tabs.findIndex(t => t.id === draggingId);
    if (fromIdx === -1) { setDraggingId(null); setInsertBefore(null); return; }
    const newTabs = [...tabs];
    const [removed] = newTabs.splice(fromIdx, 1);
    const adjustedIdx = insertBefore > fromIdx ? insertBefore - 1 : insertBefore;
    newTabs.splice(adjustedIdx, 0, removed);
    dispatch({ type: 'REORDER_TABS', payload: newTabs.map(t => t.id) });
    setDraggingId(null);
    setInsertBefore(null);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setInsertBefore(null);
  }

  return (
    <div
      className="flex h-8 bg-slate-900 border-b border-slate-800 overflow-x-auto shrink-0 scrollbar-none"
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setInsertBefore(null);
      }}
    >
      {tabs.map((tab, i) => (
        <div key={tab.id} className="relative flex items-stretch shrink-0">
          {draggingId && insertBefore === i && (
            <div className="w-0.5 bg-orange-500 self-stretch pointer-events-none shrink-0" />
          )}
          <Tab
            tab={tab}
            isActive={tab.id === activeTabId}
            isDirty={dirtyIds.has(tab.id)}
            isDragging={tab.id === draggingId}
            onActivate={() => {
              if (tab.id !== activeTabId) {
                dispatch({ type: 'SET_ACTIVE_TAB', payload: tab.id });
                dispatch({ type: 'SET_VIEW', payload: 'request' });
              }
            }}
            onClose={e => {
              e.stopPropagation();
              if (dirtyIds.has(tab.id)) {
                if (!window.confirm('This tab has unsaved changes. Close anyway and discard changes?')) return;
              }
              dispatch({ type: 'CLOSE_TAB', payload: tab.id });
            }}
            onRename={newName => {
              const collection = state.collections.find(c => c._id === tab.collectionId);
              const itemId = tab.item.id;
              if (collection && itemId) {
                dispatch({
                  type: 'UPDATE_COLLECTION',
                  payload: { ...collection, item: renameItemById(collection.item, itemId, newName) },
                });
              }
              dispatch({
                type: 'UPDATE_TAB_ITEM',
                payload: { tabId: tab.id, item: { ...tab.item, name: newName } },
              });
            }}
            onDragStart={e => handleDragStart(e, tab.id)}
            onDragOver={e => handleDragOver(e, i)}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        </div>
      ))}
      {draggingId && insertBefore === tabs.length && (
        <div className="w-0.5 bg-orange-500 self-stretch pointer-events-none shrink-0" />
      )}
    </div>
  );
}
