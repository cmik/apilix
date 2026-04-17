import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../store';
import type { RequestTab } from '../types';
import { renameItemById } from '../utils/treeHelpers';
import ConfirmModal from './ConfirmModal';

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

// ── MenuItem ──────────────────────────────────────────────────────────────────

function MenuItem({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onMouseDown={e => e.preventDefault()}
      onClick={disabled ? undefined : onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${
        disabled
          ? 'text-slate-600 cursor-not-allowed'
          : 'text-slate-300 hover:bg-slate-700 hover:text-slate-100 cursor-pointer'
      }`}
    >
      <span className="w-3.5 h-3.5 shrink-0 text-slate-500 flex items-center justify-center">
        {icon}
      </span>
      {label}
    </button>
  );
}

// ── TabContextMenu ────────────────────────────────────────────────────────────

interface TabContextMenuProps {
  tabId: string;
  tabIndex: number;
  isDirty: boolean;
  isActive: boolean;
  totalTabs: number;
  pos: { x: number; y: number };
  onClose: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onCloseSaved: () => void;
  onCloseAllToRight: () => void;
  onCloseOthers: () => void;
}

function TabContextMenu({
  tabIndex,
  isDirty,
  isActive,
  totalTabs,
  pos,
  onClose,
  onRename,
  onDuplicate,
  onCloseSaved,
  onCloseAllToRight,
  onCloseOthers,
}: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const menuWidth = 224;
  const menuHeight = 172; // approximate: 2 items + divider + 3 items at ~32px each
  const adjustedX = Math.min(pos.x, window.innerWidth - menuWidth - 8);
  const adjustedY = Math.min(pos.y, window.innerHeight - menuHeight - 8);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // "Close saved" is only disabled when the tab is dirty AND not active
  // (non-active dirty tabs can't be saved without activating them first)
  const closeSavedDisabled = isDirty && !isActive;

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: adjustedY, left: adjustedX, zIndex: 9999 }}
      className="animate-menu-enter w-56 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl overflow-hidden py-1"
    >
      <MenuItem
        icon={
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 3.487a2.25 2.25 0 1 1 3.182 3.182L7.5 19.213l-4.5 1.318 1.318-4.5L16.862 3.487z" />
          </svg>
        }
        label="Rename"
        onClick={onRename}
      />
      <MenuItem
        icon={
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
          </svg>
        }
        label="Duplicate"
        onClick={onDuplicate}
      />
      <div className="my-1 border-t border-slate-700" />
      <MenuItem
        icon={
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
          </svg>
        }
        label={closeSavedDisabled ? 'Close saved (activate tab first)' : 'Close saved'}
        onClick={onCloseSaved}
        disabled={closeSavedDisabled}
      />
      <MenuItem
        icon={
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
          </svg>
        }
        label="Close all to the right"
        onClick={onCloseAllToRight}
        disabled={tabIndex >= totalTabs - 1}
      />
      <MenuItem
        icon={
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        }
        label="Close others"
        onClick={onCloseOthers}
        disabled={totalTabs <= 1}
      />
    </div>,
    document.body
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────

function Tab({
  tab,
  isActive,
  isDirty,
  isDragging,
  isRenaming,
  onActivate,
  onClose,
  onRename,
  onStartRename,
  onCancelRename,
  onOpenMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  tab: RequestTab;
  isActive: boolean;
  isDirty: boolean;
  isDragging: boolean;
  isRenaming: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
  onRename: (newName: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onOpenMenu: (e: React.MouseEvent, usePointer?: boolean) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const method = tab.item.request?.method?.toUpperCase() ?? 'GET';
  const methodColor = METHOD_COLORS[method] ?? 'text-slate-400';
  const name = tab.item.name;

  // Local rename input value — reset whenever rename mode starts
  const [renameVal, setRenameVal] = useState(name);
  useEffect(() => {
    if (isRenaming) setRenameVal(name);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRenaming]);

  function commitRename() {
    const trimmed = renameVal.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else onCancelRename();
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={isRenaming ? undefined : (isActive ? onOpenMenu : onActivate)}
      onContextMenu={e => { e.preventDefault(); onOpenMenu(e, true); }}
      onMouseDown={e => { if (e.button === 1) { e.preventDefault(); onClose(e as unknown as React.MouseEvent); } }}
      className={`group relative flex items-center gap-1.5 px-3 py-0 h-full cursor-grab select-none shrink-0 border-r border-slate-800 transition-colors ${
        isRenaming ? 'max-w-[260px]' : 'max-w-[200px]'
      } ${isDragging ? 'opacity-40' : ''} ${
        isActive
          ? 'bg-slate-950 text-slate-100 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-orange-500'
          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
      }`}
      title={isRenaming ? undefined : name}
    >
      <span className={`text-[10px] font-bold shrink-0 ${methodColor}`}>{method.slice(0, 4)}</span>

      {isRenaming ? (
        <input
          autoFocus
          value={renameVal}
          onChange={e => setRenameVal(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancelRename(); }
          }}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-slate-700 border border-orange-500 rounded px-1.5 py-0 text-xs text-slate-100 focus:outline-none"
        />
      ) : (
        <>
          <span className="truncate text-xs min-w-0 flex-1">{name}</span>

          {/* Pencil rename button (hover-only) */}
          <button
            onClick={e => { e.stopPropagation(); onStartRename(); }}
            className="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Rename"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 3.487a2.25 2.25 0 1 1 3.182 3.182L7.5 19.213l-4.5 1.318 1.318-4.5L16.862 3.487z" />
            </svg>
          </button>

          {/* Chevron hint on active tab — shows menu is available; hidden on hover to give room for other buttons */}
          {isActive && (
            <span className="w-2.5 h-2.5 shrink-0 text-slate-600 flex items-center justify-center pointer-events-none group-hover:hidden">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 10l5 5 5-5z" />
              </svg>
            </span>
          )}

          {/* Dirty dot or close button */}
          {isDirty ? (
            <span
              className="w-2 h-2 rounded-full bg-orange-400 shrink-0 group-hover:hidden"
              title="Unsaved changes"
            />
          ) : null}
          <button
            onClick={e => { e.stopPropagation(); onClose(e); }}
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
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

  // Lifted rename state (controlled externally so context menu can trigger it)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);

  // Context menu state
  const [menuState, setMenuState] = useState<{
    tabId: string;
    pos: { x: number; y: number };
  } | null>(null);

  // Scroll navigation state
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [showScrollButtons, setShowScrollButtons] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const hasOverflow = scrollWidth > clientWidth + 1;
    setShowScrollButtons(hasOverflow);
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 1);
  }, []);

  // Re-check when tab list changes (tabs added/removed/reordered)
  useEffect(() => {
    const raf = requestAnimationFrame(updateScrollState);
    return () => cancelAnimationFrame(raf);
  }, [tabs, updateScrollState]);

  // Scroll the active tab into view whenever the active tab changes
  useEffect(() => {
    if (!activeTabId || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  // Re-check on container resize (window resize, panel resizing, etc.)
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  function handleScrollLeft() {
    scrollContainerRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  }

  function handleScrollRight() {
    scrollContainerRef.current?.scrollBy({ left: 200, behavior: 'smooth' });
  }

  // ── Context menu helpers ──────────────────────────────────────────────────

  function openMenu(tabId: string, e: React.MouseEvent, usePointer = false) {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuState({
      tabId,
      pos: usePointer
        ? { x: e.clientX, y: e.clientY + 4 }
        : { x: rect.left, y: rect.bottom + 2 },
    });
  }

  function handleMenuRename(tabId: string) {
    setMenuState(null);
    setRenamingTabId(tabId);
  }

  function handleMenuDuplicate(tabId: string) {
    setMenuState(null);
    dispatch({ type: 'DUPLICATE_TAB', payload: tabId });
  }

  function handleMenuCloseSaved(tabId: string) {
    setMenuState(null);
    const tab = tabs.find(t => t.id === tabId);
    const isOrphaned = !tab?.collectionId;
    if (isOrphaned && dirtyIds.has(tabId) && tabId === activeTabId) {
      // Dirty orphaned tab: prompt the user to save to a collection first, then close
      document.dispatchEvent(new CustomEvent('apilix:save-close'));
      return;
    }
    if (dirtyIds.has(tabId)) {
      // Save only works reliably for the active tab (RequestBuilder listens to apilix:save)
      if (tabId === activeTabId) {
        document.dispatchEvent(new CustomEvent('apilix:save'));
        // Use rAF to wait for one render cycle after the save updates dirty state
        requestAnimationFrame(() => dispatch({ type: 'CLOSE_TAB', payload: tabId }));
      }
      return;
    }
    dispatch({ type: 'CLOSE_TAB', payload: tabId });
  }

  function handleMenuCloseAllToRight(tabId: string) {
    setMenuState(null);
    const idx = tabs.findIndex(t => t.id === tabId);
    tabs.slice(idx + 1)
      .filter(t => !dirtyIds.has(t.id))
      .forEach(t => dispatch({ type: 'CLOSE_TAB', payload: t.id }));
  }

  function handleMenuCloseOthers(tabId: string) {
    setMenuState(null);
    tabs.filter(t => t.id !== tabId && !dirtyIds.has(t.id))
      .forEach(t => dispatch({ type: 'CLOSE_TAB', payload: t.id }));
  }

  // ── Rename helpers ────────────────────────────────────────────────────────

  function commitRenameForTab(tabId: string, newName: string) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) { setRenamingTabId(null); return; }
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
      payload: { tabId, item: { ...tab.item, name: newName } },
    });
    setRenamingTabId(null);
  }

  // ── Drag helpers ──────────────────────────────────────────────────────────

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

  const menuTab = menuState ? tabs.find(t => t.id === menuState.tabId) ?? null : null;
  const menuTabIndex = menuState ? tabs.findIndex(t => t.id === menuState.tabId) : -1;

  return (
    <div className="relative h-8 bg-slate-900 border-b border-slate-800 shrink-0">
      {/* Left scroll button — overlays the scroll container with a gradient fade */}
      {showScrollButtons && (
        <button
          onMouseDown={e => e.preventDefault()}
          onClick={handleScrollLeft}
          disabled={!canScrollLeft}
          className="absolute left-0 top-0 bottom-0 z-10 w-7 flex items-center justify-center
            bg-gradient-to-r from-slate-900 via-slate-900/80 to-transparent
            text-slate-400 hover:text-orange-400 disabled:text-slate-700
            transition-colors duration-150"
          title="Scroll tabs left"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Scrollable tabs container */}
      <div
        ref={scrollContainerRef}
        className={`flex h-full overflow-x-auto scrollbar-none${showScrollButtons ? ' px-7' : ''}`}
        onScroll={updateScrollState}
        onDragLeave={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setInsertBefore(null);
        }}
      >
        {tabs.map((tab, i) => (
          <div key={tab.id} data-tab-id={tab.id} className="relative flex items-stretch shrink-0">
            {draggingId && insertBefore === i && (
              <div className="w-0.5 bg-orange-500 self-stretch pointer-events-none shrink-0" />
            )}
            <Tab
              tab={tab}
              isActive={tab.id === activeTabId}
              isDirty={dirtyIds.has(tab.id)}
              isDragging={tab.id === draggingId}
              isRenaming={renamingTabId === tab.id}
              onActivate={() => {
                if (tab.id !== activeTabId) {
                  dispatch({ type: 'SET_ACTIVE_TAB', payload: tab.id });
                  dispatch({ type: 'SET_VIEW', payload: 'request' });
                }
              }}
              onClose={e => {
                e.stopPropagation();
                if (dirtyIds.has(tab.id)) {
                  setPendingCloseTabId(tab.id);
                  return;
                }
                dispatch({ type: 'CLOSE_TAB', payload: tab.id });
              }}
              onRename={newName => commitRenameForTab(tab.id, newName)}
              onStartRename={() => { setMenuState(null); setRenamingTabId(tab.id); }}
              onCancelRename={() => setRenamingTabId(null)}
              onOpenMenu={(e, usePointer) => openMenu(tab.id, e, usePointer)}
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
        <button
          onClick={() => dispatch({ type: 'OPEN_BLANK_TAB' })}
          className="flex items-center justify-center w-7 h-full shrink-0 text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
          title="New request"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      {/* Right scroll button — overlays the scroll container with a gradient fade */}
      {showScrollButtons && (
        <button
          onMouseDown={e => e.preventDefault()}
          onClick={handleScrollRight}
          disabled={!canScrollRight}
          className="absolute right-0 top-0 bottom-0 z-10 w-7 flex items-center justify-center
            bg-gradient-to-l from-slate-900 via-slate-900/80 to-transparent
            text-slate-400 hover:text-orange-400 disabled:text-slate-700
            transition-colors duration-150"
          title="Scroll tabs right"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* Context menu (portaled to body to avoid overflow clipping) */}
      {menuState && menuTab && (
        <TabContextMenu
          tabId={menuState.tabId}
          tabIndex={menuTabIndex}
          isDirty={dirtyIds.has(menuState.tabId)}
          isActive={menuState.tabId === activeTabId}
          totalTabs={tabs.length}
          pos={menuState.pos}
          onClose={() => setMenuState(null)}
          onRename={() => handleMenuRename(menuState.tabId)}
          onDuplicate={() => handleMenuDuplicate(menuState.tabId)}
          onCloseSaved={() => handleMenuCloseSaved(menuState.tabId)}
          onCloseAllToRight={() => handleMenuCloseAllToRight(menuState.tabId)}
          onCloseOthers={() => handleMenuCloseOthers(menuState.tabId)}
        />
      )}

      {/* Unsaved-tab close confirmation modal */}
      {pendingCloseTabId && (() => {
        const tab = tabs.find(t => t.id === pendingCloseTabId);
        return (
          <ConfirmModal
            title="Unsaved changes"
            message={<><strong className="text-slate-200">{tab?.item.name ?? 'This tab'}</strong> has unsaved changes. Closing it will permanently discard them.</>}
            confirmLabel="Close anyway — discard changes"
            onConfirm={() => {
              dispatch({ type: 'CLOSE_TAB', payload: pendingCloseTabId });
              setPendingCloseTabId(null);
            }}
            onCancel={() => setPendingCloseTabId(null)}
          />
        );
      })()}
    </div>
  );
}
