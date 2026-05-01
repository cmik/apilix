import { useState } from 'react';
import { CODE_GEN_LANGUAGES, type CodeGenParams } from '../utils/codeGen';
import { buildCurlCommand } from '../utils/curlUtils';

interface Props {
  params: CodeGenParams;
  onClose: () => void;
}

export default function CodeGenModal({ params, onClose }: Props) {
  const [langId, setLangId] = useState('python');
  const [copied, setCopied] = useState(false);

  const activeLang = CODE_GEN_LANGUAGES.find(l => l.id === langId) ?? CODE_GEN_LANGUAGES[0];

  // Generate code — cURL delegates to the existing utility
  function getCode(): string {
    if (langId === 'curl') {
      return buildCurlCommand(params);
    }
    return activeLang.generate(params);
  }

  const code = getCode();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable in some contexts
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl w-full max-w-3xl mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <h3 className="text-sm font-semibold text-slate-200">Code Generation</h3>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Language selector + copy */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700 shrink-0">
          <label className="text-xs text-slate-400 shrink-0">Language</label>
          <select
            value={langId}
            onChange={e => { setLangId(e.target.value); setCopied(false); }}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500 flex-1 max-w-xs"
          >
            <option value="curl">cURL</option>
            {CODE_GEN_LANGUAGES.map(l => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
          <button
            onClick={handleCopy}
            className={`ml-auto px-4 py-1.5 text-sm font-medium rounded transition-colors shrink-0 ${
              copied
                ? 'bg-green-700 border border-green-600 text-green-100'
                : 'bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-200'
            }`}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Code block */}
        <div className="flex-1 overflow-auto min-h-0">
          <pre className="p-4 text-sm font-mono text-slate-100 leading-relaxed whitespace-pre-wrap break-words">
            <code>{code}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
