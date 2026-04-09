import { useState } from 'react';
import { useApp, generateId } from '../store';
import CollectionTree from './CollectionTree';
import ImportModal from './ImportModal';
import ExportModal from './ExportModal';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import WorkspaceManagerModal from './WorkspaceManagerModal';

export default function Sidebar() {
  const { state, dispatch } = useApp(); // dispatch used by collection actions
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [filter, setFilter] = useState('');
  const [newCollectionId, setNewCollectionId] = useState<string | null>(null);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [expandSignal, setExpandSignal] = useState(0);
  const [sortAZ, setSortAZ] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div className="w-full bg-slate-900 flex flex-col h-full overflow-hidden">
      {/* Workspace switcher */}
      <div className="px-2 pt-2 pb-1 border-b border-slate-700 shrink-0">
        <WorkspaceSwitcher onManage={() => setManageOpen(true)} />
      </div>
      {manageOpen && <WorkspaceManagerModal onClose={() => setManageOpen(false)} />}
      {/* Collections toolbar */}
      <div className="px-3 py-2 border-b border-slate-700 flex items-center shrink-0">
        <button
          onClick={() => {
            const id = generateId();
            dispatch({
              type: 'ADD_COLLECTION',
              payload: {
                _id: id,
                info: { name: 'New Collection', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                item: [],
              },
            });
            setNewCollectionId(id);
          }}
          title="Create new collection"
          className="px-2 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors"
        >
          + New
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setShowExport(true)}
            title="Export collections / environments"
            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors"
            disabled={state.collections.length === 0 && state.environments.length === 0}
          >
            Export
          </button>
          <button
            onClick={() => setShowImport(true)}
            title="Import collection / environment"
            className="px-2 py-1 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors"
          >
            Import
          </button>
        </div>
      </div>

      {/* Collections header + filter */}
      <div className="flex items-center px-3 py-2 border-b border-slate-700 shrink-0">
        <span className="text-slate-500 text-xs uppercase tracking-wider">Collections ({state.collections.length})</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setSortAZ(s => !s)}
            title={sortAZ ? 'Custom order (drag to reorder)' : 'Sort A→Z'}
            disabled={state.collections.length === 0}
            className={`text-xs leading-none transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${sortAZ ? 'text-orange-400 hover:text-orange-300' : 'text-slate-500 hover:text-slate-300'}`}
          >
            A↓Z
          </button>
          <button
            onClick={() => setExpandSignal(s => s + 1)}
            title="Expand all"
            disabled={state.collections.length === 0}
            className="text-slate-500 hover:text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed text-sm leading-none transition-colors"
          >
            ⊞
          </button>
          <button
            onClick={() => setCollapseSignal(s => s + 1)}
            title="Collapse all"
            disabled={state.collections.length === 0}
            className="text-slate-500 hover:text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed text-sm leading-none transition-colors"
          >
            ⊟
          </button>
        </div>
      </div>
      <div className="px-3 py-1.5 border-b border-slate-700 shrink-0">
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">🔍</span>
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter requests…"
            className="w-full bg-slate-800 border border-slate-600 rounded pl-6 pr-6 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-orange-500"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm leading-none"
            >×</button>
          )}
        </div>
      </div>
      <CollectionTree filter={filter} renamingCollectionId={newCollectionId} onRenamingDone={() => setNewCollectionId(null)} collapseSignal={collapseSignal} expandSignal={expandSignal} sortAZ={sortAZ} />

      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  );
}
