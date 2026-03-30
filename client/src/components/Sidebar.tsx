import { useState } from 'react';
import { useApp } from '../store';
import CollectionTree from './CollectionTree';
import ImportModal from './ImportModal';

export default function Sidebar() {
  const { state, dispatch } = useApp();
  const [showImport, setShowImport] = useState(false);
  const [filter, setFilter] = useState('');

  return (
    <div className="w-full bg-slate-900 flex flex-col h-full overflow-hidden">
      {/* Brand */}
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
        <span className="font-bold text-xl tracking-widest" style={{color: '#a8b2bd', background: 'linear-gradient(90deg, #8a9bb0, #c8d6e0, #8a9bb0)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text'}}>APILIX</span>
        <button
          onClick={() => setShowImport(true)}
          title="Import collection / environment"
          className="px-2 py-1 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors"
        >
          + Import
        </button>
      </div>

      {/* Nav buttons */}
      <div className="flex border-b border-slate-700 shrink-0">
        {(
          [
            { key: 'request', label: '⚡ Requests' },
            { key: 'runner', label: '▶ Runner' },
            { key: 'environments', label: '🌍 Envs' },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => dispatch({ type: 'SET_VIEW', payload: key })}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              state.view === key
                ? 'text-orange-400 border-b-2 border-orange-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Collections header + filter */}
      <div className="flex items-center px-3 py-2 border-b border-slate-700 shrink-0">
        <span className="text-slate-500 text-xs uppercase tracking-wider">Collections</span>
        <span className="ml-auto text-slate-600 text-xs">{state.collections.length}</span>
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
      <CollectionTree filter={filter} />

      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}
