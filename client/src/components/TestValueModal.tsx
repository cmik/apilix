import { useEffect, useRef } from 'react';
import { buildJsonPathDisplayExpression, buildTestValueSnippets } from '../utils/testSnippetUtils';
import { INJECT_TEST_SNIPPET } from '../utils/appEvents';
import type { InjectTestSnippetDetail } from '../utils/appEvents';

export interface TestValueModalProps {
  path: (string | number)[];
  value: unknown;
  tabId?: string | null;
  onClose: () => void;
}

function previewValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > 50 ? `"${value.slice(0, 47)}..."` : `"${value}"`;
  }
  const str = String(value);
  return str.length > 50 ? str.slice(0, 47) + '...' : str;
}

export default function TestValueModal({ path, value, tabId, onClose }: TestValueModalProps) {
  const snippets = buildTestValueSnippets(path, value);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  function inject(snippet: string) {
    document.dispatchEvent(
      new CustomEvent<InjectTestSnippetDetail>(INJECT_TEST_SNIPPET, { detail: { snippet, tabId } })
    );
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Test this value</h2>
            <p className="text-xs text-slate-500 mt-0.5 font-mono">
              {buildJsonPathDisplayExpression(path)} = <span className="text-slate-400">{previewValue(value)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded hover:bg-slate-700"
            aria-label="Close"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-3 flex flex-col gap-2">
          {snippets.map((snippet, index) => (
            <button
              key={snippet.label}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              onClick={() => inject(snippet.snippet)}
              className="w-full text-left bg-slate-800 hover:bg-slate-700/60 border border-slate-700 hover:border-orange-500/50 rounded-md p-3 transition-colors group"
            >
              <div className="text-xs font-semibold text-slate-300 group-hover:text-slate-100 mb-1.5">
                {snippet.label}
              </div>
              <pre className="text-xs font-mono text-slate-500 group-hover:text-slate-400 whitespace-pre-wrap break-all leading-relaxed">
                {snippet.snippet}
              </pre>
            </button>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-slate-700 shrink-0">
          <p className="text-xs text-slate-600">Click a snippet to add it to the Tests script.</p>
        </div>
      </div>
    </div>
  );
}