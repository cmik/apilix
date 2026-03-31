import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { PostmanItem, AppCollection } from '../types';
import { useApp } from '../store';
import { renameItemById, updateItemById, removeItemById, addItemToFolder } from '../utils/treeHelpers';
import ItemSettingsModal from './ItemSettingsModal';

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-blue-400',
  PUT: 'text-yellow-400',
  PATCH: 'text-orange-400',
  DELETE: 'text-red-400',
  HEAD: 'text-purple-400',
  OPTIONS: 'text-slate-400',
};

function getUrlShort(url: NonNullable<PostmanItem['request']>['url'] | undefined): string {
  if (!url) return '';
  if (typeof url === 'string') return url;
  return url.raw || (Array.isArray(url.path) ? '/' + url.path.join('/') : '');
}

// --- Context Menu ---

interface MenuItem {
  label: string;
  icon: string;
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
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => { item.onClick(); onClose(); }}
          className={`w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-slate-700 ${
            item.danger ? 'text-red-400 hover:text-red-300' : 'text-slate-200'
          }`}
        >
          <span className="w-4 shrink-0 text-center">{item.icon}</span>
          {item.label}
        </button>
      ))}
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
  return (
    <input
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
      className="px-1.5 py-1 text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity text-base leading-none shrink-0 font-bold select-none"
      title="Actions"
    >
      ···
    </button>
  );
}

// --- ItemNode ---

interface ItemNodeProps {
  item: PostmanItem;
  collectionId: string;
  collection: AppCollection;
  depth: number;
  startRenaming?: boolean;
}

function ItemNode({ item, collectionId, collection, depth, startRenaming }: ItemNodeProps) {
  const { state, dispatch } = useApp();
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(!!startRenaming);
  const [renameVal, setRenameVal] = useState(item.name);
  const [showSettings, setShowSettings] = useState(false);
  const [newItemId, setNewItemId] = useState<string | null>(null);

  const isFolder = Array.isArray(item.item);
  const isActive =
    !isFolder &&
    state.activeRequest?.collectionId === collectionId &&
    state.activeRequest?.item.name === item.name;

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
    }
    setRenaming(false);
  }

  function handleDelete() {
    if (!item.id) return;
    const label = isFolder
      ? `folder "${item.name}" and all its contents`
      : `request "${item.name}"`;
    if (confirm(`Delete ${label}?`)) {
      dispatch({
        type: 'UPDATE_COLLECTION',
        payload: { ...collection, item: removeItemById(collection.item, item.id) },
      });
    }
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

  const menuItems: MenuItem[] = [
    isFolder
      ? { label: 'View settings', icon: '⚙️', onClick: () => setShowSettings(true) }
      : {
          label: 'Open',
          icon: '↗',
          onClick: () => {
            dispatch({ type: 'OPEN_TAB', payload: { collectionId, item } });
            dispatch({ type: 'SET_VIEW', payload: 'request' });
          },
        },
    ...(isFolder ? [
      { label: 'Add folder', icon: '📁', onClick: handleAddFolder },
      { label: 'Add request', icon: '➕', onClick: handleAddRequest },
    ] : []),
    {
      label: 'Rename',
      icon: '✏️',
      onClick: () => { setRenameVal(item.name); setRenaming(true); },
    },
    { label: 'Delete', icon: '🗑', danger: true, onClick: handleDelete },
  ];

  const indentPx = depth * 12 + 8;

  // -- Folder --
  if (isFolder) {
    return (
      <div>
        <div
          className="flex items-center group rounded hover:bg-slate-700/50"
          style={{ paddingLeft: indentPx }}
        >
          <button
            onClick={() => !renaming && setOpen(o => !o)}
            className="flex items-center gap-1.5 flex-1 min-w-0 py-1 text-sm text-slate-300"
          >
            <span className="text-xs text-slate-500 shrink-0">{open ? '▾' : '▸'}</span>
            <span className="shrink-0">📁</span>
            {renaming
              ? <InlineRename value={renameVal} onChange={setRenameVal} onConfirm={commitRename} onCancel={() => setRenaming(false)} />
              : <span className="truncate">{item.name}</span>
            }
          </button>
          <KebabBtn onClick={openMenu} />
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
          <ItemSettingsModal
            kind="folder"
            name={item.name}
            auth={item.auth}
            event={item.event}
            onSave={(auth, events) => {
              if (!item.id) return;
              const updated: PostmanItem = { ...item, auth, event: events.length ? events : undefined };
              dispatch({
                type: 'UPDATE_COLLECTION',
                payload: { ...collection, item: updateItemById(collection.item, item.id, updated) },
              });
            }}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    );
  }

  // -- Request --
  const method = item.request?.method?.toUpperCase() || 'GET';
  return (
    <div
      className={`flex items-center group rounded text-sm transition-colors ${
        isActive ? 'bg-slate-600' : 'hover:bg-slate-700/50'
      }`}
      style={{ paddingLeft: indentPx }}
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
  );
}

// --- CollectionNode ---

function CollectionNode({ collection, startRenaming, onRenamingDone }: { collection: AppCollection; startRenaming?: boolean; onRenamingDone?: () => void }) {
  const { dispatch } = useApp();
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(!!startRenaming);
  const [renameVal, setRenameVal] = useState(startRenaming ? '' : collection.info.name);
  const [showSettings, setShowSettings] = useState(false);
  const [newItemId, setNewItemId] = useState<string | null>(null);

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

  const menuItems: MenuItem[] = [
    { label: 'View settings', icon: '⚙️', onClick: () => setShowSettings(true) },
    { label: 'Export', icon: '⬇️', onClick: handleExport },
    { label: 'Add folder', icon: '📁', onClick: handleAddFolder },
    { label: 'Add request', icon: '➕', onClick: handleAddRequest },
    {
      label: 'Rename',
      icon: '✏️',
      onClick: () => { setRenameVal(collection.info.name); setRenaming(true); },
    },
    {
      label: 'Delete',
      icon: '🗑',
      danger: true,
      onClick: () => {
        if (confirm(`Remove collection "${collection.info.name}"?`))
          dispatch({ type: 'REMOVE_COLLECTION', payload: collection._id });
      },
    },
  ];

  return (
    <div className="mb-1">
      <div className="flex items-center group">
        <button
          onClick={() => !renaming && setOpen(o => !o)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-2 py-1.5 hover:bg-slate-700/50 rounded text-sm font-medium text-slate-200"
        >
          <span className="text-xs shrink-0">{open ? '▾' : '▸'}</span>
          <span className="shrink-0">📚</span>
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
        <ItemSettingsModal
          kind="collection"
          name={collection.info.name}
          auth={collection.auth}
          event={collection.event}
          onSave={(auth, events) => {
            dispatch({
              type: 'UPDATE_COLLECTION',
              payload: { ...collection, auth, event: events.length ? events : undefined },
            });
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

// --- Flat search helpers ---

interface FlatRequest {
  item: PostmanItem;
  collectionId: string;
  collectionName: string;
  breadcrumb: string;
}

function flattenAll(collections: AppCollection[]): FlatRequest[] {
  const results: FlatRequest[] = [];
  function walk(items: PostmanItem[], collectionId: string, collectionName: string, path: string) {
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
}

export default function CollectionTree({ filter = '', renamingCollectionId, onRenamingDone }: CollectionTreeProps) {
  const { state, dispatch } = useApp();
  const trimmed = filter.trim();

  if (state.collections.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
        <div className="text-4xl mb-3">📭</div>
        <p className="text-slate-400 text-sm">No collections yet</p>
        <p className="text-slate-600 text-xs mt-1">Click Import to get started</p>
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
          <div className="text-3xl mb-2">🔍</div>
          <p className="text-slate-400 text-sm">No requests match</p>
          <p className="text-slate-600 text-xs mt-1">"{trimmed}"</p>
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto py-1">
        {matched.map((r, i) => {
          const method = r.item.request?.method?.toUpperCase() || 'GET';
          const isActive =
            state.activeRequest?.collectionId === r.collectionId &&
            state.activeRequest?.item.name === r.item.name;
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
    <div className="flex-1 overflow-y-auto py-1">
      {state.collections.map(col => (
        <CollectionNode
          key={col._id}
          collection={col}
          startRenaming={col._id === renamingCollectionId}
          onRenamingDone={onRenamingDone}
        />
      ))}
    </div>
  );
}
