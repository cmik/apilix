import { useState, useEffect, useRef } from 'react';
import { buildJsonPathDisplayExpression, buildSaveToVarSnippet } from '../utils/testSnippetUtils';

export interface SaveToVarModalProps {
  path: (string | number)[];
  value: unknown;
  collectionId: string | null;
  onConfirm: (varName: string, scope: 'environment' | 'globals' | 'collection') => void;
  onClose: () => void;
}

function defaultVarName(path: (string | number)[]): string {
  const lastString = [...path].reverse().find(s => typeof s === 'string') as string | undefined;
  const raw = lastString ?? 'value';
  // Strip leading chars that are not valid JS identifier starters, then replace
  // remaining non-identifier chars with underscores so the pre-fill passes the
  // strict regex used by this modal.
  const sanitized = raw
    .replace(/^[^a-zA-Z_$]+/, '')
    .replace(/[^a-zA-Z0-9_$]/g, '_');
  return sanitized || 'value';
}

function previewValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > 60 ? `"${value.slice(0, 57)}…"` : `"${value}"`;
  }
  const str = String(value);
  return str.length > 60 ? str.slice(0, 57) + '…' : str;
}

export default function SaveToVarModal({ path, value, collectionId, onConfirm, onClose }: SaveToVarModalProps) {
  const [varName, setVarName] = useState(defaultVarName(path));
  const [scope, setScope] = useState<'environment' | 'globals' | 'collection'>('environment');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isValidName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(varName);
  const canSave = varName.trim().length > 0 && isValidName;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onConfirm(varName.trim(), scope);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-sm mx-4 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <h2 className="text-sm font-semibold text-slate-100">Save as Variable</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded hover:bg-slate-700"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="px-4 py-4 flex flex-col gap-4">
          {/* Path + value preview */}
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-slate-500 uppercase tracking-wider">Selected value</p>
            <div className="bg-slate-800 border border-slate-700 rounded px-3 py-2 flex flex-col gap-1">
              <span className="text-xs font-mono text-orange-400">{buildJsonPathDisplayExpression(path)}</span>
              <span className="text-xs font-mono text-emerald-400 truncate">{previewValue(value)}</span>
            </div>
          </div>

          {/* Scope */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="save-to-var-scope" className="text-xs text-slate-400 font-medium">
              Scope
            </label>
            <select
              id="save-to-var-scope"
              value={scope}
              onChange={e => setScope(e.target.value as 'environment' | 'globals' | 'collection')}
              className="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
            >
              <option value="environment">Environment</option>
              <option value="globals">Globals</option>
              <option value="collection" disabled={!collectionId}>
                Collection{!collectionId ? ' (no active collection)' : ''}
              </option>
            </select>
          </div>

          {/* Variable name */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="save-to-var-name" className="text-xs text-slate-400 font-medium">
              Variable name
            </label>
            <input
              id="save-to-var-name"
              ref={inputRef}
              type="text"
              value={varName}
              onChange={e => setVarName(e.target.value)}
              placeholder="e.g. authToken"
              className={`bg-slate-800 border rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none font-mono ${
                varName && !isValidName
                  ? 'border-red-500 focus:border-red-400'
                  : 'border-slate-600 focus:border-orange-500'
              }`}
            />
            {varName === '' && (
              <p className="text-xs text-slate-500">Enter a variable name to generate the snippet</p>
            )}
            {varName && !isValidName && (
              <p className="text-xs text-red-400">Must start with a letter, $, or _ and contain only letters, digits, $, _</p>
            )}
          </div>

          {/* Generated snippet preview — built from the same util used for injection */}
          {canSave && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-slate-500 uppercase tracking-wider">Script to inject</p>
              <pre className="bg-slate-800 rounded px-3 py-2 text-xs font-mono text-slate-300 whitespace-pre-wrap break-all border border-slate-700">
                {buildSaveToVarSnippet(varName, scope, path)}
              </pre>
            </div>
          )}
          {/* Footer — inside the form so Enter also submits */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Add to Tests
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
