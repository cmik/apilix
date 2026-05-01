import { useState, useRef, useEffect, createContext, useContext, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import type { CollectionItem, AppCollection, MockCollection, MockRoute } from '../types';
import { useApp, generateId } from '../store';
import { buildVarMap, buildCollectionDefinitionVarMap, resolveVariables } from '../utils/variableResolver';
import { buildVariableSuggestions } from '../utils/variableAutocomplete';
import {
  renameItemById, updateItemById, removeItemById, addItemToFolder, duplicateItem,
  moveItemInTree, extractItemById, insertItemInTree, isDescendantOf, getAllRequestIds,
  flattenRequestNames, flattenRequestItems, sortChildrenByName,
  removeItemsByIds, getCollectionLevelCandidates, getItemLevelCandidates,
  getAncestorItemIds, REVEAL_IN_TREE_EVENT,
  type BulkDeleteCandidate,
} from '../utils/treeHelpers';
import { generateHurlFromItems } from '../utils/hurlUtils';
import { useImportFile } from '../utils/useImportFile';
import ConfirmModal from './ConfirmModal';
import {
  IconViewSettings,
  IconOpen,
  IconAddRequest,
  IconAddFolder,
  IconSort,
  IconRunner,
  IconMock,
  IconRename,
  IconDuplicate,
  IconDelete,
  IconFolder as IconFolderComponent,
  IconCollection,
  IconChevronDown,
  IconSearch,
  IconClose,
  IconDownload,
  IconEmptyMailbox,
} from './Icons';

const ItemSettingsModal = lazy(() => import('./ItemSettingsModal'));

// ─── Send-to-Mock helpers ────────────────────────────────────────────────────

function flattenMockItems(items: CollectionItem[]): CollectionItem[] {
  const result: CollectionItem[] = [];
  for (const item of items) {
    if (Array.isArray(item.item)) result.push(...flattenMockItems(item.item));
    else if (item.request) result.push(item);
  }
  return result;
}

function extractMockPath(url: CollectionItem['request'] extends undefined ? never : NonNullable<CollectionItem['request']>['url']): string {
  if (!url) return '/';
  const raw = typeof url === 'string' ? url : (url as any)?.raw ?? '';
  try { return new URL(raw).pathname || '/'; } catch {}
  if (raw.startsWith('/')) return raw.split('?')[0];
  return (raw.replace(/^https?:\/\/[^/]+/, '') || '/').split('?')[0] || '/';
}

function toMockRoute(item: CollectionItem, collectionId?: string, varMap: Record<string, string> = {}): MockRoute {
  const req = item.request!;
  const rawUrl = typeof req.url === 'string' ? req.url : (req.url as any)?.raw ?? '';
  const resolvedUrl = resolveVariables(rawUrl, varMap);
  const resolvedUrlObj = typeof req.url === 'string' ? resolvedUrl : { ...(req.url as object), raw: resolvedUrl };
  return {
    id: generateId(),
    enabled: true,
    collectionId,
    method: (req.method ?? 'GET').toUpperCase(),
    path: extractMockPath(resolvedUrlObj as typeof req.url),
    statusCode: 200,
    responseHeaders: [{ key: 'Content-Type', value: 'application/json' }],
    responseBody: '{\n  "ok": true\n}',
    delay: 0,
    description: item.name,
    rules: [],
    script: '',
  };
}

type MockTargetChoice =
  | { mode: 'new'; name: string }
  | { mode: 'existing'; collectionId: string }
  | { mode: 'uncollected' };

function SendToMockModal({
  suggestedName, routeCount, existingMockCollections, onConfirm, onClose,
}: {
  suggestedName: string;
  routeCount: number;
  existingMockCollections: MockCollection[];
  onConfirm: (choice: MockTargetChoice) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'new' | 'existing' | 'uncollected'>('new');
  const [name, setName] = useState(suggestedName);
  const [existingId, setExistingId] = useState(existingMockCollections[0]?.id ?? '');

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canConfirm = mode === 'new' ? name.trim().length > 0 : mode === 'existing' ? !!existingId : true;

  function handleConfirm() {
    if (!canConfirm) return;
    if (mode === 'new') onConfirm({ mode: 'new', name: name.trim() });
    else if (mode === 'existing') onConfirm({ mode: 'existing', collectionId: existingId });
    else onConfirm({ mode: 'uncollected' });
    onClose();
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-sm flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
            <h2 className="text-sm font-semibold text-white">
              Add to Mock Server
              <span className="ml-2 text-slate-400 font-normal text-xs">({routeCount} route{routeCount !== 1 ? 's' : ''})</span>
            </h2>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
              <IconClose className="w-5 h-5" />
            </button>
          </div>
          <div className="px-5 py-4 space-y-2">
            <label className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${mode === 'new' ? 'border-orange-500 bg-orange-500/5' : 'border-slate-700 hover:border-slate-600'}`}>
              <input type="radio" name="send-mock-mode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} className="accent-orange-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-slate-200">Create new mock collection</p>
                {mode === 'new' && (
                  <input
                    autoFocus
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && canConfirm) handleConfirm(); }}
                    placeholder="Collection name…"
                    className="mt-2 w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                  />
                )}
              </div>
            </label>
            {existingMockCollections.length > 0 && (
              <label className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${mode === 'existing' ? 'border-orange-500 bg-orange-500/5' : 'border-slate-700 hover:border-slate-600'}`}>
                <input type="radio" name="send-mock-mode" value="existing" checked={mode === 'existing'} onChange={() => setMode('existing')} className="accent-orange-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-200">Add to existing mock collection</p>
                  {mode === 'existing' && (
                    <select
                      value={existingId}
                      onChange={e => setExistingId(e.target.value)}
                      className="mt-2 w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                    >
                      {existingMockCollections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                </div>
              </label>
            )}
            <label className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${mode === 'uncollected' ? 'border-orange-500 bg-orange-500/5' : 'border-slate-700 hover:border-slate-600'}`}>
              <input type="radio" name="send-mock-mode" value="uncollected" checked={mode === 'uncollected'} onChange={() => setMode('uncollected')} className="accent-orange-500 shrink-0" />
              <p className="text-xs font-medium text-slate-200">Add as uncollected routes</p>
            </label>
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-700">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors">Cancel</button>
            <button onClick={handleConfirm} disabled={!canConfirm} className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded font-medium transition-colors">Add Routes</button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ─── Drag & Drop Context ──────────────────────────────────────────────────────

type DragPosition = 'before' | 'after' | 'inside';

interface DragContextValue {
  draggingId: string | null;
  draggingColId: string | null;
  dropId: string | null;
  dropColId: string | null;
  dropPos: DragPosition | null;
  startDrag: (id: string, colId: string) => void;
  endDrag: () => void;
  updateDrop: (id: string | null, colId: string | null, pos: DragPosition | null) => void;
  executeDrop: () => void;
}

const noop = () => {};
const defaultDragCtx: DragContextValue = {
  draggingId: null, draggingColId: null,
  dropId: null, dropColId: null, dropPos: null,
  startDrag: noop, endDrag: noop, updateDrop: noop, executeDrop: noop,
};

const DragCtx = createContext<DragContextValue>(defaultDragCtx);
function useDragCtx() { return useContext(DragCtx); }

// ─── Collapse/Expand-all contexts ───────────────────────────────────────────────
const CollapseCtx = createContext<number>(0);
const ExpandCtx = createContext<number>(0);

interface RevealState {
  collectionId: string;
  itemId: string;
  ancestorIds: Set<string>;
}

const RevealCtx = createContext<RevealState | null>(null);

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-blue-400',
  PUT: 'text-yellow-400',
  PATCH: 'text-orange-400',
  DELETE: 'text-red-400',
  HEAD: 'text-purple-400',
  OPTIONS: 'text-slate-400',
};

function getUrlShort(url: NonNullable<CollectionItem['request']>['url'] | undefined): string {
  if (!url) return '';
  if (typeof url === 'string') return url;
  return url.raw || (Array.isArray(url.path) ? '/' + url.path.join('/') : '');
}

// --- Context Menu ---

interface MenuItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep within viewport
  const LEFT = Math.min(x, window.innerWidth - 180);
  const TOP = Math.min(y, window.innerHeight - items.length * 34 - 8);

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top: TOP, left: LEFT, zIndex: 9999 }}
      className="bg-slate-800 border border-slate-600 rounded-md shadow-2xl py-1 min-w-[160px]"
    >
      {items.map((item, i) => {
        const IconComponent = item.icon;
        return (
          <button
            key={i}
            onClick={() => { item.onClick(); onClose(); }}
            className={`w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-slate-700 ${
              item.danger ? 'text-red-400 hover:text-red-300' : 'text-slate-200'
            }`}
          >
            <IconComponent className="w-4 h-4 shrink-0" />
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

// --- BulkDeleteModal ---

interface BulkDeleteModalProps {
  candidates: BulkDeleteCandidate[];
  /** Id of the item that triggered the action — pre-selected. */
  initialSelectedId?: string;
  onConfirm: (selectedIds: Set<string>) => void;
  onCancel: () => void;
}

const KIND_LABEL: Record<BulkDeleteCandidate['kind'], string> = {
  collection: 'Collection',
  folder: 'Folder',
  request: 'Request',
};
const KIND_BADGE: Record<BulkDeleteCandidate['kind'], string> = {
  collection: 'text-orange-400 bg-orange-400/10',
  folder: 'text-sky-400 bg-sky-400/10',
  request: 'text-slate-300 bg-slate-700',
};

function BulkDeleteModal({ candidates, initialSelectedId, onConfirm, onCancel }: BulkDeleteModalProps) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (initialSelectedId) s.add(initialSelectedId);
    return s;
  });

  // Keep a stable ref to onCancel so the Escape listener doesn't need to
  // re-register on every parent render.
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; });

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? candidates.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.path.toLowerCase().includes(q) ||
        c.collectionName.toLowerCase().includes(q)
      )
    : candidates;

  const allVisible = filtered.length > 0 && filtered.every(c => selected.has(c.id));
  const noneVisibleSelected = filtered.length > 0 && filtered.every(c => !selected.has(c.id));

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(prev => { const next = new Set(prev); filtered.forEach(c => next.add(c.id)); return next; });
  }

  function clearVisible() {
    setSelected(prev => { const next = new Set(prev); filtered.forEach(c => next.delete(c.id)); return next; });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancelRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []); // stable — onCancelRef.current is updated above on every render

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="relative z-10 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-lg mx-4 flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <h2 className="text-sm font-semibold text-slate-200">Delete multiple</h2>
          <button onClick={onCancel} className="text-slate-500 hover:text-slate-200 px-1">
            <IconClose className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex flex-col px-5 py-4 gap-3 min-h-0">
          <input
            type="text"
            placeholder="Filter items…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none shrink-0"
            autoFocus
          />

          <div className="flex items-center justify-between shrink-0">
            <span className="text-xs text-slate-500">
              {selected.size} of {candidates.length} selected
            </span>
            <div className="flex gap-3">
              <button
                onClick={selectAllVisible}
                disabled={allVisible}
                className="text-xs text-orange-400 hover:text-orange-300 transition-colors disabled:opacity-40"
              >
                Select all visible
              </button>
              <button
                onClick={clearVisible}
                disabled={noneVisibleSelected}
                className="text-xs text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40"
              >
                Clear visible
              </button>
            </div>
          </div>

          <ul className="flex-1 overflow-y-auto space-y-0.5 pr-1 min-h-0">
            {filtered.length === 0 && (
              <li className="text-xs text-slate-500 italic px-2 py-4 text-center">No items match</li>
            )}
            {filtered.map(candidate => (
              <li key={candidate.id}>
                <label className="flex items-start gap-2.5 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.id)}
                    onChange={() => toggle(candidate.id)}
                    className="accent-orange-500 shrink-0 mt-0.5"
                  />
                  {candidate.kind === 'folder' ? (
                    <IconFolderComponent className="w-4 h-4 shrink-0 text-sky-400" />
                  ) : candidate.kind === 'request' ? (
                    <IconOpen className="w-4 h-4 shrink-0 text-slate-400" />
                  ) : (
                    <IconViewSettings className="w-4 h-4 shrink-0 text-orange-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-200 truncate">{candidate.name}</div>
                    {candidate.kind !== 'collection' && (
                      <div className="text-[10px] text-slate-500 truncate mt-0.5">
                        {[candidate.collectionName, candidate.path].filter(Boolean).join(' / ')}
                      </div>
                    )}
                  </div>
                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0 self-start mt-0.5 ${KIND_BADGE[candidate.kind]}`}>
                    {KIND_LABEL[candidate.kind]}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-700 flex items-center justify-between shrink-0">
          <p className="text-xs text-slate-500 mr-4">
            {selected.size > 0
              ? <>Permanently delete <strong className="text-red-400">{selected.size}</strong> item{selected.size !== 1 ? 's' : ''}. Cannot be undone.</>
              : 'Select items to delete.'}
          </p>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-xs rounded border border-slate-700 hover:border-slate-600 text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={selected.size === 0}
              onClick={() => onConfirm(selected)}
              className="px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Delete{selected.size > 0 ? ` ${selected.size}` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- Inline rename input ---

function InlineRename({
  value,
  onChange,
  onConfirm,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      autoFocus
      value={value}
      onChange={e => onChange(e.target.value)}
      onBlur={onConfirm}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onClick={e => e.stopPropagation()}
      className="flex-1 min-w-0 bg-slate-700 border border-orange-500 rounded px-1.5 py-0 text-sm text-slate-100 focus:outline-none"
    />
  );
}

// --- Kebab button ---

function KebabBtn({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className="px-1.5 py-1 mr-1 text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity text-base leading-none shrink-0 font-bold select-none"
      title="Actions"
    >
      ···
    </button>
  );
}

// --- ItemNode ---

interface ItemNodeProps {
  item: CollectionItem;
  collectionId: string;
  collection: AppCollection;
  depth: number;
  startRenaming?: boolean;
}

function ItemNode({ item, collectionId, collection, depth, startRenaming }: ItemNodeProps) {
  const { state, dispatch, getEnvironmentVars, getCollectionVars } = useApp();
  const collectionDefinitionVars = buildCollectionDefinitionVarMap(collection.variable);
  const varMap = buildVarMap(
    getEnvironmentVars(),
    getCollectionVars(collectionId),
    state.globalVariables,
    collectionDefinitionVars,
  );
  const variableSuggestions = buildVariableSuggestions(varMap);
  const dragCtx = useDragCtx();
  const collapseSignal = useContext(CollapseCtx);
  const expandSignal = useContext(ExpandCtx);
  const revealCtx = useContext(RevealCtx);
  const [open, setOpen] = useState(() => expandSignal >= collapseSignal);

  useEffect(() => {
    if (collapseSignal > 0 && Array.isArray(item.item)) setOpen(false);
  }, [collapseSignal]);
  useEffect(() => {
    if (expandSignal > 0 && Array.isArray(item.item)) setOpen(true);
  }, [expandSignal]);
  // Auto-open this folder when it is an ancestor of the revealed item
  useEffect(() => {
    if (item.id && Array.isArray(item.item) && revealCtx?.ancestorIds.has(item.id)) setOpen(true);
  }, [revealCtx]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(!!startRenaming);
  const [renameVal, setRenameVal] = useState(item.name);
  const [showSettings, setShowSettings] = useState(false);
  const [newItemId, setNewItemId] = useState<string | null>(null);
  const [mockItems, setMockItems] = useState<CollectionItem[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string; isFolder: boolean } | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const isFolder = Array.isArray(item.item);
  const isActive =
    !isFolder &&
    state.activeRequest?.collectionId === collectionId &&
    (item.id
      ? state.activeRequest?.item.id === item.id
      : state.activeRequest?.item.name === item.name);
  const isRevealed =
    !isFolder &&
    !!item.id &&
    revealCtx?.collectionId === collectionId &&
    revealCtx?.itemId === item.id;

  // Scroll the revealed request row into view
  useEffect(() => {
    if (isRevealed && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isRevealed]);

  function openMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  function commitRename() {
    const newName = renameVal.trim();
    if (newName && newName !== item.name && item.id) {
      dispatch({
        type: 'UPDATE_COLLECTION',
        payload: { ...collection, item: renameItemById(collection.item, item.id, newName) },
      });
      // Sync any open tabs that hold a snapshot of this item
      state.tabs.forEach(tab => {
        if (tab.item.id === item.id) {
          dispatch({
            type: 'UPDATE_TAB_ITEM',
            payload: { tabId: tab.id, item: { ...tab.item, name: newName } },
          });
        }
      });
    }
    setRenaming(false);
  }

  function handleDelete() {
    if (!item.id) return;
    setMenu(null);
    setPendingDelete({ id: item.id, name: item.name, isFolder });
  }

  function handleBulkDelete() {
    setMenu(null);
    setBulkDeleteOpen(true);
  }

  function confirmBulkDelete(selectedIds: Set<string>) {
    const latestCollection = state.collections.find(c => c._id === collection._id);
    if (!latestCollection) { setBulkDeleteOpen(false); return; }
    dispatch({
      type: 'UPDATE_COLLECTION',
      payload: { ...latestCollection, item: removeItemsByIds(latestCollection.item, selectedIds) },
    });
    setBulkDeleteOpen(false);
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    const latestCollection = state.collections.find(c => c._id === collection._id);
    if (!latestCollection) return;
    dispatch({
      type: 'UPDATE_COLLECTION',
      payload: { ...latestCollection, item: removeItemById(latestCollection.item, pendingDelete.id) },
    });
    setPendingDelete(null);
  }

  function handleAddFolder() {
    if (!item.id) return;
    const newId = Math.random().toString(36).slice(2);
    const newFolder = { id: newId, name: 'New Folder', item: [] };
    setOpen(true);
    setNewItemId(newId);
    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...collection, item: addItemToFolder(collection.item, item.id, newFolder) } });
  }

  function handleAddRequest() {
    if (!item.id) return;
    const newId = Math.random().toString(36).slice(2);
    const newReq = { id: newId, name: 'New Request', request: { method: 'GET', url: { raw: '', path: [] }, header: [] } };
    setOpen(true);
    setNewItemId(newId);
    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...collection, item: addItemToFolder(collection.item, item.id, newReq) } });
  }

  function handleDuplicate() {
    if (!item.id) return;
    dispatch({
      type: 'UPDATE_COLLECTION',
      payload: { ...collection, item: duplicateItem(collection.item, item.id) },
    });
  }

  // --- Drag & Drop handlers ---

  function handleDragStart(e: React.DragEvent) {
    if (!item.id || renaming) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
    dragCtx.startDrag(item.id, collectionId);
  }

  function handleDragEnd() {
    dragCtx.endDrag();
  }

  function handleDragOver(e: React.DragEvent) {
    if (!item.id || !dragCtx.draggingId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (!rowRef.current) return;
    const rect = rowRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;

    let pos: DragPosition;
    if (isFolder) {
      if (y < h * 0.3) pos = 'before';
      else if (y > h * 0.7) pos = 'after';
      else pos = 'inside';
    } else {
      pos = y < h * 0.5 ? 'before' : 'after';
    }

    if (dragCtx.dropId !== item.id || dragCtx.dropColId !== collectionId || dragCtx.dropPos !== pos) {
      dragCtx.updateDrop(item.id, collectionId, pos);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCtx.executeDrop();
  }

  const isBeingDragged = dragCtx.draggingId === item.id;
  const isDropTarget = dragCtx.dropId === item.id && dragCtx.dropColId === collectionId;
  const dropPos = isDropTarget ? dragCtx.dropPos : null;

  const menuItems: MenuItem[] = [
    isFolder
      ? { label: 'View settings', icon: IconViewSettings, onClick: () => setShowSettings(true) }
      : {
          label: 'Open',
          icon: IconOpen,
          onClick: () => {
            dispatch({ type: 'OPEN_TAB', payload: { collectionId, item } });
            dispatch({ type: 'SET_VIEW', payload: 'request' });
          },
        },
    ...(isFolder ? [
      { label: 'Add request', icon: IconAddRequest, onClick: handleAddRequest },
      { label: 'Add folder', icon: IconAddFolder, onClick: handleAddFolder },
      ...((item.item?.length ?? 0) >= 2 && !!item.id ? [{
        label: 'Order items A→Z',
        icon: IconSort,
        onClick: () => {
          dispatch({ type: 'UPDATE_COLLECTION', payload: { ...collection, item: sortChildrenByName(collection.item, item.id) } });
        },
      }] : []),
    ] : []),
    {
      label: 'Execute in Runner',
      icon: IconRunner,
      onClick: () => {
        const ids = isFolder ? getAllRequestIds(item.item || []) : (item.id ? [item.id] : []);
        dispatch({ type: 'SET_RUNNER_PRESELECTION', payload: { collectionId, requestIds: ids } });
        dispatch({ type: 'SET_VIEW', payload: 'runner' });
      },
    },
    {
      label: 'Add to Mock Server',
      icon: IconMock,
      onClick: () => {
        const items = isFolder ? flattenMockItems(item.item || []) : (item.request ? [item] : []);
        if (items.length > 0) setMockItems(items);
      },
    },
    {
      label: 'Rename',
      icon: IconRename,
      onClick: () => { setRenameVal(item.name); setRenaming(true); },
    },
    { label: 'Duplicate', icon: IconDuplicate, onClick: handleDuplicate },
    { label: 'Delete', icon: IconDelete, danger: true, onClick: handleDelete },
    { label: 'Delete multiple…', icon: IconDelete, danger: true, onClick: handleBulkDelete },
  ];

  const indentPx = depth * 12 + 8;

  // -- Folder --
  if (isFolder) {
    return (
      <div>
        <div className="relative">
          {dropPos === 'before' && (
            <div className="absolute top-0 left-2 right-0 h-0.5 bg-orange-500 rounded-full z-10 pointer-events-none" />
          )}
          <div
            ref={rowRef}
            draggable={!renaming}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className={`flex items-center group rounded select-none ${
              isBeingDragged ? 'opacity-40' : ''
            } ${
              dropPos === 'inside'
                ? 'bg-orange-500/10 ring-1 ring-inset ring-orange-500/60'
                : 'hover:bg-slate-700/50'
            }`}
            style={{ paddingLeft: indentPx, cursor: renaming ? 'default' : 'grab' }}
          >
            <button
              onClick={() => !renaming && setOpen(o => !o)}
              className="flex items-center gap-1.5 flex-1 min-w-0 py-1 text-sm text-slate-300"
            >
              <IconChevronDown className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
              <IconFolderComponent className="w-4 h-4 shrink-0 text-slate-400" />
              {renaming
                ? <InlineRename value={renameVal} onChange={setRenameVal} onConfirm={commitRename} onCancel={() => setRenaming(false)} />
                : <span className="truncate">{item.name}</span>
              }
            </button>
            <KebabBtn onClick={openMenu} />
          </div>
          {dropPos === 'after' && (
            <div className="absolute bottom-0 left-2 right-0 h-0.5 bg-orange-500 rounded-full z-10 pointer-events-none" />
          )}
        </div>

        {open && (
          <div>
            {(item.item || []).map((child, i) => (
              <ItemNode
                key={child.id || i}
                item={child}
                collectionId={collectionId}
                collection={collection}
                depth={depth + 1}
                startRenaming={child.id === newItemId}
              />
            ))}
          </div>
        )}

        {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

        {showSettings && (
          <Suspense fallback={null}>
            <ItemSettingsModal
              kind="folder"
              name={item.name}
              auth={item.auth}
              event={item.event}
              description={item.description}
              requestNames={flattenRequestNames(collection.item)}
              requestItems={flattenRequestItems(collection.item)}
              onSave={(auth, events, description) => {
                if (!item.id) return;
                const updated: CollectionItem = { ...item, auth, event: events.length ? events : undefined, description: description || undefined };
                dispatch({
                  type: 'UPDATE_COLLECTION',
                  payload: { ...collection, item: updateItemById(collection.item, item.id, updated) },
                });
              }}
              onClose={() => setShowSettings(false)}
              variableSuggestions={variableSuggestions}
            />
          </Suspense>
        )}

        {mockItems && (
          <SendToMockModal
            suggestedName={item.name}
            routeCount={mockItems.length}
            existingMockCollections={state.mockCollections}
            onConfirm={(choice) => {
              let collectionId: string | undefined;
              if (choice.mode === 'new') {
                collectionId = generateId();
                dispatch({ type: 'ADD_MOCK_COLLECTION', payload: { id: collectionId, name: choice.name, enabled: true, description: '' } });
              } else if (choice.mode === 'existing') {
                collectionId = choice.collectionId;
              }
              for (const req of mockItems) dispatch({ type: 'ADD_MOCK_ROUTE', payload: toMockRoute(req, collectionId, varMap) });
              dispatch({ type: 'SET_VIEW', payload: 'mock' });
            }}
            onClose={() => setMockItems(null)}
          />
        )}

        {pendingDelete && (
          <ConfirmModal
            title={pendingDelete.isFolder ? 'Delete folder?' : 'Delete request?'}
            message={pendingDelete.isFolder
              ? <>Delete folder <strong className="text-slate-200">{pendingDelete.name}</strong> and all its contents? This cannot be undone.</>
              : <>Delete request <strong className="text-slate-200">{pendingDelete.name}</strong>? This cannot be undone.</>
            }
            confirmLabel="Delete"
            danger={true}
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        )}

        {bulkDeleteOpen && item.id && (
          <BulkDeleteModal
            candidates={getItemLevelCandidates(collection.item, item.id, collectionId, collection.info.name)}
            initialSelectedId={item.id}
            onConfirm={confirmBulkDelete}
            onCancel={() => setBulkDeleteOpen(false)}
          />
        )}
      </div>
    );
  }

  // -- Request --
  const method = item.request?.method?.toUpperCase() || 'GET';
  return (
    <div className="relative">
      {dropPos === 'before' && (
        <div className="absolute top-0 left-2 right-0 h-0.5 bg-orange-500 rounded-full z-10 pointer-events-none" />
      )}
      <div
        ref={rowRef}
        draggable={!renaming}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`flex items-center group rounded text-sm transition-colors select-none ${
          isActive ? 'bg-slate-600' : 'hover:bg-slate-700/50'
        } ${isBeingDragged ? 'opacity-40' : ''} ${isRevealed ? 'ring-2 ring-inset ring-orange-500' : ''}`}
        style={{ paddingLeft: indentPx, cursor: renaming ? 'default' : 'grab' }}
      >
        <button
          className="flex items-center gap-2 flex-1 min-w-0 py-1.5"
          onClick={() => {
            if (renaming) return;
            dispatch({ type: 'OPEN_TAB', payload: { collectionId, item } });
            dispatch({ type: 'SET_VIEW', payload: 'request' });
          }}
        >
          <span className={`text-xs font-bold w-12 shrink-0 ${METHOD_COLORS[method] || 'text-slate-400'}`}>
            {method.slice(0, 6)}
          </span>
          {renaming
            ? <InlineRename value={renameVal} onChange={setRenameVal} onConfirm={commitRename} onCancel={() => setRenaming(false)} />
            : <span className={`truncate ${isActive ? 'text-white' : 'text-slate-300'}`}>{item.name}</span>
          }
        </button>
        <KebabBtn onClick={openMenu} />
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      </div>
      {dropPos === 'after' && (
        <div className="absolute bottom-0 left-2 right-0 h-0.5 bg-orange-500 rounded-full z-10 pointer-events-none" />
      )}
      {mockItems && (
        <SendToMockModal
          suggestedName={item.name}
          routeCount={mockItems.length}
          existingMockCollections={state.mockCollections}
          onConfirm={(choice) => {
            let cid: string | undefined;
            if (choice.mode === 'new') {
              cid = generateId();
              dispatch({ type: 'ADD_MOCK_COLLECTION', payload: { id: cid, name: choice.name, enabled: true, description: '' } });
            } else if (choice.mode === 'existing') {
              cid = choice.collectionId;
            }
            for (const req of mockItems) dispatch({ type: 'ADD_MOCK_ROUTE', payload: toMockRoute(req, cid, varMap) });
            dispatch({ type: 'SET_VIEW', payload: 'mock' });
          }}
          onClose={() => setMockItems(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Delete request?"
          message={<>Delete request <strong className="text-slate-200">{pendingDelete.name}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          danger={true}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {bulkDeleteOpen && item.id && (
        <BulkDeleteModal
          candidates={getItemLevelCandidates(collection.item, item.id, collectionId, collection.info.name)}
          initialSelectedId={item.id}
          onConfirm={confirmBulkDelete}
          onCancel={() => setBulkDeleteOpen(false)}
        />
      )}
    </div>
  );
}

// --- CollectionNode ---

function CollectionNode({ collection, startRenaming, onRenamingDone, isDragging, onDragStart, onDragEnd }: {
  collection: AppCollection;
  startRenaming?: boolean;
  onRenamingDone?: () => void;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const { state, dispatch, getEnvironmentVars, getCollectionVars } = useApp();
  const dragCtx = useDragCtx();
  const collectionDefinitionVars = buildCollectionDefinitionVarMap(collection.variable ?? []);
  const varMap = buildVarMap(
    getEnvironmentVars(),
    getCollectionVars(collection._id),
    state.globalVariables,
    collectionDefinitionVars,
  );
  const variableSuggestions = buildVariableSuggestions(varMap);
  const collapseSignal = useContext(CollapseCtx);
  const expandSignal = useContext(ExpandCtx);
  const revealCtx = useContext(RevealCtx);
  const [open, setOpen] = useState(() => expandSignal >= collapseSignal);

  useEffect(() => {
    if (collapseSignal > 0) setOpen(false);
  }, [collapseSignal]);
  useEffect(() => {
    if (expandSignal > 0) setOpen(true);
  }, [expandSignal]);
  // Auto-open this collection when it contains the revealed item
  useEffect(() => {
    if (revealCtx?.collectionId === collection._id) setOpen(true);
  }, [revealCtx]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(!!startRenaming);
  const [renameVal, setRenameVal] = useState(startRenaming ? '' : collection.info.name);
  const [showSettings, setShowSettings] = useState(false);
  const [newItemId, setNewItemId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  function handleHeaderDragOver(e: React.DragEvent) {
    if (!dragCtx.draggingId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dragCtx.dropColId !== collection._id || dragCtx.dropId !== null || dragCtx.dropPos !== 'inside') {
      dragCtx.updateDrop(null, collection._id, 'inside');
    }
  }

  function handleHeaderDrop(e: React.DragEvent) {
    if (!dragCtx.draggingId) return;
    e.preventDefault();
    e.stopPropagation();
    dragCtx.executeDrop();
  }

  function openMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  function commitRename() {
    const newName = renameVal.trim();
    if (newName && newName !== collection.info.name) {
      dispatch({
        type: 'UPDATE_COLLECTION',
        payload: { ...collection, info: { ...collection.info, name: newName } },
      });
    }
    setRenaming(false);
    onRenamingDone?.();
  }

  function handleAddFolder() {
    const newId = Math.random().toString(36).slice(2);
    const newFolder = { id: newId, name: 'New Folder', item: [] };
    setOpen(true);
    setNewItemId(newId);
    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...collection, item: [...collection.item, newFolder] } });
  }

  function handleAddRequest() {
    const newId = Math.random().toString(36).slice(2);
    const newReq = { id: newId, name: 'New Request', request: { method: 'GET', url: { raw: '', path: [] }, header: [] } };
    setOpen(true);
    setNewItemId(newId);
    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...collection, item: [...collection.item, newReq] } });
  }

  function handleExport() {
    const exported = {
      info: {
        name: collection.info.name,
        description: collection.info.description,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        _postman_id: collection._id,
      },
      item: collection.item,
      auth: collection.auth,
      event: collection.event,
      variable: collection.variable,
    };
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${collection.info.name.replace(/[^a-z0-9_\-. ]/gi, '_')}.postman_collection.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportHurl() {
    const hurlContent = generateHurlFromItems(collection.item);
    const blob = new Blob([hurlContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${collection.info.name.replace(/[^a-z0-9_\-. ]/gi, '_')}.hurl`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleSendCollectionToMock() {
    const requests = flattenMockItems(collection.item);
    if (requests.length === 0) return;
    const colId = generateId();
    const staticCollVars = Object.fromEntries((collection.variable ?? []).filter(v => v.key && !v.disabled).map(v => [v.key, v.value]));
    const varMap = buildVarMap(getEnvironmentVars(), { ...staticCollVars, ...getCollectionVars(collection._id) }, state.globalVariables);
    dispatch({ type: 'ADD_MOCK_COLLECTION', payload: { id: colId, name: collection.info.name, enabled: true, description: '' } });
    for (const req of requests) dispatch({ type: 'ADD_MOCK_ROUTE', payload: toMockRoute(req, colId, varMap) });
    dispatch({ type: 'SET_VIEW', payload: 'mock' });
  }

  function promptDeleteCollection() {
    setMenu(null);
    setPendingDelete({ id: collection._id, name: collection.info.name });
  }

  function confirmDeleteCollection() {
    if (!pendingDelete) return;
    dispatch({ type: 'REMOVE_COLLECTION', payload: pendingDelete.id });
    setPendingDelete(null);
  }

  function handleBulkDelete() {
    setMenu(null);
    setBulkDeleteOpen(true);
  }

  function confirmBulkDelete(selectedIds: Set<string>) {
    const collectionIds = new Set(state.collections.map(c => c._id));
    const selectedCollectionIds = new Set([...selectedIds].filter(id => collectionIds.has(id)));

    // Build map of item ids to delete per collection, skipping collections being fully removed
    const candidates = getCollectionLevelCandidates(state.collections);
    const itemsByCollection = new Map<string, Set<string>>();
    for (const cand of candidates) {
      if (cand.kind === 'collection') continue;
      if (!selectedIds.has(cand.id)) continue;
      if (selectedCollectionIds.has(cand.collectionId)) continue; // parent collection already being removed
      if (!itemsByCollection.has(cand.collectionId)) itemsByCollection.set(cand.collectionId, new Set());
      itemsByCollection.get(cand.collectionId)!.add(cand.id);
    }

    for (const colId of selectedCollectionIds) {
      dispatch({ type: 'REMOVE_COLLECTION', payload: colId });
    }
    for (const [colId, itemIds] of itemsByCollection) {
      const col = state.collections.find(c => c._id === colId);
      if (!col) continue;
      dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: removeItemsByIds(col.item, itemIds) } });
    }

    setBulkDeleteOpen(false);
  }

  const menuItems: MenuItem[] = [
    { label: 'View settings', icon: IconViewSettings, onClick: () => setShowSettings(true) },
    { label: 'Add request', icon: IconAddRequest, onClick: handleAddRequest },
    { label: 'Add folder', icon: IconAddFolder, onClick: handleAddFolder },
    {
      label: 'Execute in Runner',
      icon: IconRunner,
      onClick: () => {
        const ids = getAllRequestIds(collection.item);
        dispatch({ type: 'SET_RUNNER_PRESELECTION', payload: { collectionId: collection._id, requestIds: ids } });
        dispatch({ type: 'SET_VIEW', payload: 'runner' });
      },
    },
    { label: 'Add to Mock Server', icon: IconMock, onClick: handleSendCollectionToMock },
    { label: 'Export', icon: IconDownload, onClick: handleExport },
    { label: 'Export as HURL', icon: IconDownload, onClick: handleExportHurl },
    ...(collection.item.length >= 2 ? [{
      label: 'Order items A→Z',
      icon: IconSort,
      onClick: () => {
        dispatch({ type: 'UPDATE_COLLECTION', payload: { ...collection, item: sortChildrenByName(collection.item) } });
      },
    }] : []),
    {
      label: 'Rename',
      icon: IconRename,
      onClick: () => { setRenameVal(collection.info.name); setRenaming(true); },
    },
    {
      label: 'Delete',
      icon: IconDelete,
      danger: true,
      onClick: promptDeleteCollection,
    },
    {
      label: 'Delete multiple…',
      icon: IconDelete,
      danger: true,
      onClick: handleBulkDelete,
    },
  ];

  const isCollectionDropTarget =
    dragCtx.draggingId !== null &&
    dragCtx.dropId === null &&
    dragCtx.dropColId === collection._id &&
    dragCtx.dropPos === 'inside';

  function handleCollectionDragOver(e: React.DragEvent) {
    if (!dragCtx.draggingId) return;
    // When open and non-empty, ItemNodes handle drag events via stopPropagation.
    // Only act as a drop target when the collection is closed or empty.
    if (open && collection.item.length > 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!isCollectionDropTarget) {
      dragCtx.updateDrop(null, collection._id, 'inside');
    }
  }

  function handleCollectionDrop(e: React.DragEvent) {
    if (!dragCtx.draggingId) return;
    e.preventDefault();
    e.stopPropagation();
    dragCtx.executeDrop();
  }

  return (
    <div
      className={`mb-1 transition-opacity ${isDragging ? 'opacity-40' : ''}`}
      onDragOver={handleCollectionDragOver}
      onDrop={handleCollectionDrop}
    >
      <div
        className={`flex items-center group rounded transition-colors ${isCollectionDropTarget ? 'ring-1 ring-inset ring-orange-500/60 bg-orange-500/10' : ''}`}
        draggable={!!onDragStart}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={handleHeaderDragOver}
        onDrop={handleHeaderDrop}
      >
        <button
          onClick={() => !renaming && setOpen(o => !o)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-2 py-1.5 hover:bg-slate-700/50 rounded text-sm font-medium text-slate-200"
        >
          <IconChevronDown className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
          <IconCollection className="w-4 h-4 shrink-0 text-slate-300" />
          {renaming
            ? <InlineRename value={renameVal} onChange={setRenameVal} onConfirm={commitRename} onCancel={() => { setRenaming(false); onRenamingDone?.(); }} />
            : <span className="truncate">{collection.info.name}</span>
          }
        </button>
        <KebabBtn onClick={openMenu} />
      </div>

      {open && (
        <div className="ml-1">
          {collection.item.map((item, i) => (
            <ItemNode
              key={item.id || i}
              item={item}
              collectionId={collection._id}
              collection={collection}
              depth={1}
              startRenaming={item.id === newItemId}
            />
          ))}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {showSettings && (
        <Suspense fallback={null}>
          <ItemSettingsModal
            kind="collection"
            name={collection.info.name}
            auth={collection.auth}
            event={collection.event}
            description={collection.info.description}
            variables={collection.variable ?? []}
            requestNames={flattenRequestNames(collection.item)}
            requestItems={flattenRequestItems(collection.item)}
            onSave={(auth, events, description, variables) => {
              dispatch({
                type: 'UPDATE_COLLECTION',
                payload: {
                  ...collection,
                  auth,
                  event: events.length ? events : undefined,
                  variable: variables.length ? variables : undefined,
                  info: { ...collection.info, description: description || undefined },
                },
              });
            }}
            onClose={() => setShowSettings(false)}
            variableSuggestions={variableSuggestions}
          />
        </Suspense>
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Delete collection?"
          message={<>Remove collection <strong className="text-slate-200">{pendingDelete.name}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          danger={true}
          onConfirm={confirmDeleteCollection}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {bulkDeleteOpen && (
        <BulkDeleteModal
          candidates={getCollectionLevelCandidates(state.collections)}
          initialSelectedId={collection._id}
          onConfirm={confirmBulkDelete}
          onCancel={() => setBulkDeleteOpen(false)}
        />
      )}
    </div>
  );
}

// --- Flat search helpers ---

interface FlatRequest {
  item: CollectionItem;
  collectionId: string;
  collectionName: string;
  breadcrumb: string;
}

function flattenAll(collections: AppCollection[]): FlatRequest[] {
  const results: FlatRequest[] = [];
  function walk(items: CollectionItem[], collectionId: string, collectionName: string, path: string) {
    for (const item of items) {
      if (Array.isArray(item.item)) {
        walk(item.item, collectionId, collectionName, path ? `${path} / ${item.name}` : item.name);
      } else if (item.request) {
        results.push({ item, collectionId, collectionName, breadcrumb: path });
      }
    }
  }
  for (const col of collections) {
    walk(col.item, col._id, col.info.name, '');
  }
  return results;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lc = text.toLowerCase();
  const lq = query.toLowerCase();
  const idx = lc.indexOf(lq);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-orange-500/30 text-orange-300 not-italic rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// --- Main export ---

interface CollectionTreeProps {
  filter?: string;
  renamingCollectionId?: string | null;
  onRenamingDone?: () => void;
  collapseSignal?: number;
  expandSignal?: number;
  sortAZ?: boolean;
}

export default function CollectionTree({ filter = '', renamingCollectionId, onRenamingDone, collapseSignal = 0, expandSignal = 0, sortAZ = false }: CollectionTreeProps) {
  const { state, dispatch } = useApp();
  const importFile = useImportFile();
  const trimmed = filter.trim();

  // ── File drag-and-drop import state ─────────────────────────────────────────
  const [fileDropActive, setFileDropActive] = useState(false);

  // ── Reveal state (Show in tree view) ─────────────────────────────────────────
  const [revealState, setRevealState] = useState<RevealState | null>(null);
  // Track the active highlight timeout so rapid re-fires don't clear a newer highlight early
  // collectionsRef is declared below (shared with drag-drop logic) and always kept current
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onReveal(e: Event) {
      const { collectionId, itemId } = (e as CustomEvent<{ collectionId: string; itemId: string }>).detail;
      const col = collectionsRef.current.find(c => c._id === collectionId);
      if (!col) return;
      const ids = getAncestorItemIds(col.item, itemId);
      if (ids === null) return;
      // Cancel any pending clear from a previous reveal
      if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
      setRevealState({ collectionId, itemId, ancestorIds: new Set(ids) });
      revealTimerRef.current = setTimeout(() => {
        setRevealState(null);
        revealTimerRef.current = null;
      }, 1500);
    }
    document.addEventListener(REVEAL_IN_TREE_EVENT, onReveal);
    return () => {
      document.removeEventListener(REVEAL_IN_TREE_EVENT, onReveal);
      // Clean up timer on unmount to prevent setState on unmounted component
      if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    };
  // Intentionally empty: listener is registered once; collectionsRef stays current via mutation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isFileDrag(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes('Files');
  }

  function handleFilesDragOver(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setFileDropActive(true);
  }

  function handleFilesDragLeave(e: React.DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setFileDropActive(false);
    }
  }

  async function handleFilesDrop(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setFileDropActive(false);
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      const text = await file.text();
      await importFile(text, file.name);
    }
  }

  // ── Collection-level drag state (reordering top-level collections) ───────────
  const [draggingColIdx, setDraggingColIdx] = useState<number | null>(null);
  const [colInsertBefore, setColInsertBefore] = useState<number | null>(null);

  function handleColDragStart(e: React.DragEvent, idx: number) {
    setDraggingColIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    // Don't let the item-level drag state interfere
    e.stopPropagation();
  }

  function handleColDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? idx : idx + 1;
    if (pos !== colInsertBefore) setColInsertBefore(pos);
  }

  function handleColDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (draggingColIdx === null || colInsertBefore === null) return;
    const cols = state.collections;
    const newCols = [...cols];
    const [removed] = newCols.splice(draggingColIdx, 1);
    const adjustedIdx = colInsertBefore > draggingColIdx ? colInsertBefore - 1 : colInsertBefore;
    newCols.splice(adjustedIdx, 0, removed);
    dispatch({ type: 'REORDER_COLLECTIONS', payload: newCols.map(c => c._id) });
    setDraggingColIdx(null);
    setColInsertBefore(null);
  }

  function handleColDragEnd() {
    setDraggingColIdx(null);
    setColInsertBefore(null);
  }

  // ── Drag state ───────────────────────────────────────────────────────────────
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingColId, setDraggingColId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [dropColId, setDropColId] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<DragPosition | null>(null);

  // Refs to always have the latest values without stale-closure issues in executeDrop
  const latestDragRef = useRef({ draggingId, draggingColId, dropId, dropColId, dropPos });
  latestDragRef.current = { draggingId, draggingColId, dropId, dropColId, dropPos };
  const collectionsRef = useRef(state.collections);
  collectionsRef.current = state.collections;

  function startDrag(id: string, colId: string) {
    setDraggingId(id);
    setDraggingColId(colId);
  }

  function endDrag() {
    setDraggingId(null);
    setDraggingColId(null);
    setDropId(null);
    setDropColId(null);
    setDropPos(null);
  }

  function updateDrop(id: string | null, colId: string | null, pos: DragPosition | null) {
    setDropId(id);
    setDropColId(colId);
    setDropPos(pos);
  }

  function executeDrop() {
    const { draggingId: srcId, draggingColId: srcCol, dropId: tgtId, dropColId: tgtCol, dropPos: pos } = latestDragRef.current;
    if (!srcId || !srcCol || !tgtCol || !pos) { endDrag(); return; }
    if (srcId === tgtId) { endDrag(); return; }

    const collections = collectionsRef.current;

    // Collection-root drop: dragged onto the collection header (no specific item target)
    if (!tgtId) {
      if (pos !== 'inside') { endDrag(); return; }
      if (srcCol === tgtCol) {
        // Move to root of same collection — extract and append to end
        const col = collections.find(c => c._id === srcCol);
        if (!col) { endDrag(); return; }
        const { items: withoutSource, extracted } = extractItemById(col.item, srcId);
        if (!extracted) { endDrag(); return; }
        dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: [...withoutSource, extracted] } });
      } else {
        const srcCollection = collections.find(c => c._id === srcCol);
        const tgtCollection = collections.find(c => c._id === tgtCol);
        if (!srcCollection || !tgtCollection) { endDrag(); return; }
        const { items: newSrcItems, extracted } = extractItemById(srcCollection.item, srcId);
        if (!extracted) { endDrag(); return; }
        dispatch({ type: 'UPDATE_COLLECTION', payload: { ...srcCollection, item: newSrcItems } });
        dispatch({ type: 'UPDATE_COLLECTION', payload: { ...tgtCollection, item: [...tgtCollection.item, extracted] } });
      }
      endDrag();
      return;
    }

    if (srcCol === tgtCol) {
      const col = collections.find(c => c._id === srcCol);
      if (!col) { endDrag(); return; }
      // Prevent dragging a folder into one of its own descendants
      if (pos === 'inside' && isDescendantOf(col.item, srcId, tgtId)) { endDrag(); return; }
      const newItems = moveItemInTree(col.item, srcId, tgtId, pos);
      dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: newItems } });
    } else {
      // Cross-collection move
      const srcCollection = collections.find(c => c._id === srcCol);
      const tgtCollection = collections.find(c => c._id === tgtCol);
      if (!srcCollection || !tgtCollection) { endDrag(); return; }
      const { items: newSrcItems, extracted } = extractItemById(srcCollection.item, srcId);
      if (!extracted) { endDrag(); return; }
      const newTgtItems = insertItemInTree(tgtCollection.item, extracted, tgtId, pos);
      dispatch({ type: 'UPDATE_COLLECTION', payload: { ...srcCollection, item: newSrcItems } });
      dispatch({ type: 'UPDATE_COLLECTION', payload: { ...tgtCollection, item: newTgtItems } });
    }

    endDrag();
  }

  const dragCtxValue: DragContextValue = {
    draggingId, draggingColId, dropId, dropColId, dropPos,
    startDrag, endDrag, updateDrop, executeDrop,
  };
  // ─────────────────────────────────────────────────────────────────────────────

  if (state.collections.length === 0) {
    return (
      <div
        className={`flex-1 flex flex-col items-center justify-center text-center p-4 rounded-lg transition-colors ${
          fileDropActive ? 'bg-orange-500/10 ring-2 ring-inset ring-orange-500' : ''
        }`}
        onDragOver={handleFilesDragOver}
        onDragLeave={handleFilesDragLeave}
        onDrop={handleFilesDrop}
      >
        <IconEmptyMailbox className="w-16 h-16 mb-3 text-slate-500 mx-auto" />
        <p className="text-slate-400 text-sm">
          {fileDropActive ? 'Drop to import' : 'No collections yet'}
        </p>
        <p className="text-slate-600 text-xs mt-1">
          {fileDropActive ? '' : 'Click Import or drop a file here'}
        </p>
      </div>
    );
  }

  // -- Filtered flat view --
  if (trimmed) {
    const all = flattenAll(state.collections);
    const matched = all.filter(r => {
      const lq = trimmed.toLowerCase();
      const name = r.item.name.toLowerCase();
      const url = getUrlShort(r.item.request?.url).toLowerCase();
      const crumb = [r.collectionName, r.breadcrumb].filter(Boolean).join(' / ').toLowerCase();
      return name.includes(lq) || url.includes(lq) || crumb.includes(lq);
    });

    if (matched.length === 0) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
          <IconSearch className="w-10 h-10 mb-2 text-slate-500" />
          <p className="text-slate-400 text-sm">No requests match</p>
          <p className="text-slate-600 text-xs mt-1">"{trimmed}"</p>
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
        {matched.map((r, i) => {
          const method = r.item.request?.method?.toUpperCase() || 'GET';
          const isActive =
            state.activeRequest?.collectionId === r.collectionId &&
            (r.item.id
              ? state.activeRequest?.item.id === r.item.id
              : state.activeRequest?.item.name === r.item.name);
          const crumb = [r.collectionName, r.breadcrumb].filter(Boolean).join(' / ');
          return (
            <button
              key={i}
              onClick={() => {
                dispatch({ type: 'OPEN_TAB', payload: { collectionId: r.collectionId, item: r.item } });
                dispatch({ type: 'SET_VIEW', payload: 'request' });
              }}
              className={`flex flex-col w-full text-left px-3 py-1.5 transition-colors ${
                isActive ? 'bg-slate-600' : 'hover:bg-slate-700/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold w-12 shrink-0 ${METHOD_COLORS[method] || 'text-slate-400'}`}>
                  {method.slice(0, 6)}
                </span>
                <span className={`truncate text-sm ${isActive ? 'text-white' : 'text-slate-300'}`}>
                  <Highlight text={r.item.name} query={trimmed} />
                </span>
              </div>
              {crumb && (
                <span className="pl-14 text-xs text-slate-500 truncate">{crumb}</span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  // -- Normal tree view --
  return (
    <DragCtx.Provider value={dragCtxValue}>
      <RevealCtx.Provider value={revealState}>
      <CollapseCtx.Provider value={collapseSignal}>
      <ExpandCtx.Provider value={expandSignal}>
      <div
        className="flex-1 overflow-y-auto scrollbar-thin py-1 relative"
        onDragOver={(e) => {
          // File drops take priority over internal reorder drags
          if (isFileDrag(e)) { handleFilesDragOver(e); return; }
        }}
        onDragLeave={(e) => {
          handleFilesDragLeave(e);
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
            updateDrop(null, null, null);
            setColInsertBefore(null);
          }
        }}
        onDrop={(e) => {
          if (isFileDrag(e)) { handleFilesDrop(e); return; }
        }}
        onDragEnd={() => { endDrag(); handleColDragEnd(); }}
      >
        {fileDropActive && (
          <div className="absolute inset-0 z-20 bg-orange-500/10 ring-2 ring-inset ring-orange-500 rounded-lg pointer-events-none flex items-center justify-center">
            <span className="text-orange-400 font-medium text-sm">Drop to import</span>
          </div>
        )}
        {(sortAZ
          ? [...state.collections].sort((a, b) => a.info.name.localeCompare(b.info.name))
          : state.collections
        ).map((col, i) => (
          <div
            key={col._id}
            className="relative"
            onDragOver={sortAZ ? undefined : (e) => handleColDragOver(e, i)}
            onDrop={sortAZ ? undefined : handleColDrop}
          >
            {!sortAZ && draggingColIdx !== null && colInsertBefore === i && (
              <div className="h-0.5 bg-orange-500 rounded-full mx-2 pointer-events-none" />
            )}
            <CollectionNode
              key={col._id}
              collection={col}
              startRenaming={col._id === renamingCollectionId}
              onRenamingDone={onRenamingDone}
              isDragging={!sortAZ && draggingColIdx === i}
              onDragStart={sortAZ ? undefined : (e) => handleColDragStart(e, i)}
              onDragEnd={sortAZ ? undefined : handleColDragEnd}
            />
          </div>
        ))}
        {!sortAZ && draggingColIdx !== null && colInsertBefore === state.collections.length && (
          <div className="h-0.5 bg-orange-500 rounded-full mx-2 pointer-events-none" />
        )}
      </div>
      </ExpandCtx.Provider>
      </CollapseCtx.Provider>
      </RevealCtx.Provider>
    </DragCtx.Provider>
  );
}
