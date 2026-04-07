import { useState, useMemo } from 'react';
import { useApp } from '../store';
import type { AppCollection, AppEnvironment } from '../types';
import { generateHarFromItems } from '../utils/harUtils';
import { generateHurlFromItems } from '../utils/hurlUtils';

type ExportFormat = 'postman' | 'har' | 'hurl';

interface ExportModalProps {
  onClose: () => void;
}

export default function ExportModal({ onClose }: ExportModalProps) {
  const { state } = useApp();

  const [format, setFormat] = useState<ExportFormat>('postman');
  const [selectedCollections, setSelectedCollections] = useState<Set<string>>(
    new Set(state.collections.map(c => c._id))
  );
  const [selectedEnvironments, setSelectedEnvironments] = useState<Set<string>>(
    new Set(state.environments.map(e => e._id))
  );
  const [colFilter, setColFilter] = useState('');
  const [envFilter, setEnvFilter] = useState('');

  const filteredCollections = useMemo(() => {
    const q = colFilter.trim().toLowerCase();
    return q ? state.collections.filter(c => c.info.name.toLowerCase().includes(q)) : state.collections;
  }, [state.collections, colFilter]);

  const filteredEnvironments = useMemo(() => {
    const q = envFilter.trim().toLowerCase();
    return q ? state.environments.filter(e => e.name.toLowerCase().includes(q)) : state.environments;
  }, [state.environments, envFilter]);

  function toggleCollection(id: string) {
    setSelectedCollections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleEnvironment(id: string) {
    setSelectedEnvironments(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllCollections(checked: boolean) {
    setSelectedCollections(checked ? new Set(state.collections.map(c => c._id)) : new Set());
  }

  function toggleAllEnvironments(checked: boolean) {
    setSelectedEnvironments(checked ? new Set(state.environments.map(e => e._id)) : new Set());
  }

  function downloadCollection(col: AppCollection) {
    let content: string;
    let filename: string;
    let mimeType: string;

    const safeName = col.info.name.replace(/[^a-z0-9_\-. ]/gi, '_');

    if (format === 'har') {
      content = generateHarFromItems(col.item, col.info.name);
      filename = `${safeName}.har`;
      mimeType = 'application/json';
    } else if (format === 'hurl') {
      content = generateHurlFromItems(col.item);
      filename = `${safeName}.hurl`;
      mimeType = 'text/plain';
    } else {
      const exported = {
        info: {
          name: col.info.name,
          description: col.info.description,
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          _postman_id: col._id,
        },
        item: col.item,
        auth: col.auth,
        event: col.event,
        variable: col.variable,
      };
      content = JSON.stringify(exported, null, 2);
      filename = `${safeName}.postman_collection.json`;
      mimeType = 'application/json';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadEnvironment(env: AppEnvironment) {
    const exported = {
      id: env._id,
      name: env.name,
      values: env.values,
      _postman_variable_scope: 'environment',
    };
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${env.name.replace(/[^a-z0-9_\-. ]/gi, '_')}.postman_environment.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExport() {
    const electronAPI = (window as any).electronAPI;

    if (electronAPI?.chooseExportFolder) {
      // Desktop app: pick a folder once, then write all files to it directly
      electronAPI.chooseExportFolder().then((folder: string | null) => {
        if (!folder) return; // user cancelled
        const colsToExport = state.collections.filter(c => selectedCollections.has(c._id));
        const envsToExport = state.environments.filter(e => selectedEnvironments.has(e._id));

        const saves: Promise<void>[] = [];

        for (const col of colsToExport) {
          let content: string;
          let filename: string;
          const safeName = col.info.name.replace(/[^a-z0-9_\-. ]/gi, '_');

          if (format === 'har') {
            content = generateHarFromItems(col.item, col.info.name);
            filename = `${safeName}.har`;
          } else if (format === 'hurl') {
            content = generateHurlFromItems(col.item);
            filename = `${safeName}.hurl`;
          } else {
            const exported = {
              info: {
                name: col.info.name,
                description: col.info.description,
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
                _postman_id: col._id,
              },
              item: col.item,
              auth: col.auth,
              event: col.event,
              variable: col.variable,
            };
            content = JSON.stringify(exported, null, 2);
            filename = `${safeName}.postman_collection.json`;
          }

          saves.push(electronAPI.saveFileToDisk(`${folder}/${filename}`, content));
        }

        if (format === 'postman') {
          for (const env of envsToExport) {
            const exported = {
              id: env._id,
              name: env.name,
              values: env.values,
              _postman_variable_scope: 'environment',
            };
            const safeName = env.name.replace(/[^a-z0-9_\-. ]/gi, '_');
            const filePath = `${folder}/${safeName}.postman_environment.json`;
            saves.push(electronAPI.saveFileToDisk(filePath, JSON.stringify(exported, null, 2)));
          }
        }

        Promise.all(saves).then(() => onClose());
      });
    } else {
      // Browser: use the existing blob-download approach
      state.collections
        .filter(c => selectedCollections.has(c._id))
        .forEach(downloadCollection);
      if (format === 'postman') {
        state.environments
          .filter(e => selectedEnvironments.has(e._id))
          .forEach(downloadEnvironment);
      }
      onClose();
    }
  }

  const showEnvironments = format === 'postman';
  const totalSelected = selectedCollections.size + (showEnvironments ? selectedEnvironments.size : 0);
  const allCollectionsChecked =
    state.collections.length > 0 && selectedCollections.size === state.collections.length;
  const allEnvironmentsChecked =
    state.environments.length > 0 && selectedEnvironments.size === state.environments.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <h2 className="text-sm font-semibold text-slate-200">Export</h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 min-h-0">
          {/* Format selector */}
          <section>
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide block mb-2">
              Format
            </span>
            <div className="flex gap-1 rounded-md bg-slate-800 p-0.5">
              {(['postman', 'har', 'hurl'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFormat(f)}
                  className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    format === f
                      ? 'bg-orange-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f === 'postman' ? 'Postman JSON' : f.toUpperCase()}
                </button>
              ))}
            </div>
          </section>
          {/* Collections */}
          {state.collections.length > 0 && (
            <section className="flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2 shrink-0">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                  Collections
                  <span className="ml-1.5 text-slate-600 normal-case font-normal">
                    ({selectedCollections.size}/{state.collections.length})
                  </span>
                </span>
                <button
                  onClick={() => toggleAllCollections(!allCollectionsChecked)}
                  className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
                >
                  {allCollectionsChecked ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              {state.collections.length > 6 && (
                <input
                  type="text"
                  placeholder="Filter collections…"
                  value={colFilter}
                  onChange={e => setColFilter(e.target.value)}
                  className="mb-2 shrink-0 w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none"
                />
              )}
              <ul className="overflow-y-auto max-h-44 space-y-0.5 pr-0.5 scrollbar-thin">
                {filteredCollections.map(col => (
                  <li key={col._id}>
                    <label className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={selectedCollections.has(col._id)}
                        onChange={() => toggleCollection(col._id)}
                        className="accent-orange-500 shrink-0"
                      />
                      <span className="text-xs text-slate-300 truncate group-hover:text-slate-100 flex-1 min-w-0">
                        {col.info.name}
                      </span>
                      <span className="text-xs text-slate-600 shrink-0">
                        {col.item.length} item{col.item.length !== 1 ? 's' : ''}
                      </span>
                    </label>
                  </li>
                ))}
                {filteredCollections.length === 0 && (
                  <li className="px-2 py-2 text-xs text-slate-500 italic">No match</li>
                )}
              </ul>
            </section>
          )}

          {/* Environments */}
          {showEnvironments && state.environments.length > 0 && (
            <section className="flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2 shrink-0">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                  Environments
                  <span className="ml-1.5 text-slate-600 normal-case font-normal">
                    ({selectedEnvironments.size}/{state.environments.length})
                  </span>
                </span>
                <button
                  onClick={() => toggleAllEnvironments(!allEnvironmentsChecked)}
                  className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
                >
                  {allEnvironmentsChecked ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              {state.environments.length > 6 && (
                <input
                  type="text"
                  placeholder="Filter environments…"
                  value={envFilter}
                  onChange={e => setEnvFilter(e.target.value)}
                  className="mb-2 shrink-0 w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none"
                />
              )}
              <ul className="overflow-y-auto max-h-44 space-y-0.5 pr-0.5 scrollbar-thin">
                {filteredEnvironments.map(env => (
                  <li key={env._id}>
                    <label className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={selectedEnvironments.has(env._id)}
                        onChange={() => toggleEnvironment(env._id)}
                        className="accent-orange-500 shrink-0"
                      />
                      <span className="text-xs text-slate-300 truncate group-hover:text-slate-100 flex-1 min-w-0">
                        {env.name}
                      </span>
                      <span className="text-xs text-slate-600 shrink-0">
                        {env.values.length} var{env.values.length !== 1 ? 's' : ''}
                      </span>
                    </label>
                  </li>
                ))}
                {filteredEnvironments.length === 0 && (
                  <li className="px-2 py-2 text-xs text-slate-500 italic">No match</li>
                )}
              </ul>
            </section>
          )}

          {state.collections.length === 0 && (!showEnvironments || state.environments.length === 0) && (
            <p className="text-xs text-slate-500 italic text-center py-4">
              Nothing to export yet.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-slate-700 shrink-0">
          <span className="text-xs text-slate-500">
            {totalSelected} item{totalSelected !== 1 ? 's' : ''} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={totalSelected === 0}
              className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
