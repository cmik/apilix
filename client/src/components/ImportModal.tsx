import { useState, useRef } from 'react';
import { useApp, parseCollectionFile, parseEnvironmentFile } from '../store';

interface ImportModalProps {
  onClose: () => void;
}

export default function ImportModal({ onClose }: ImportModalProps) {
  const { dispatch } = useApp();
  const [tab, setTab] = useState<'file' | 'paste'>('file');
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function parseAndImport(text: string) {
    setError(null);
    setSuccess(null);
    try {
      const json = JSON.parse(text);
      if (json.info && json.item) {
        const col = parseCollectionFile(json);
        dispatch({ type: 'ADD_COLLECTION', payload: col });
        setSuccess(`Collection "${col.info.name}" imported!`);
      } else if (json.name && Array.isArray(json.values)) {
        const env = parseEnvironmentFile(json);
        dispatch({ type: 'ADD_ENVIRONMENT', payload: env });
        setSuccess(`Environment "${env.name}" imported!`);
      } else {
        setError('Unrecognised format. Expected a Postman Collection v2.1 or Environment JSON.');
      }
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        const text = e.target?.result as string;
        parseAndImport(text);
      };
      reader.readAsText(file);
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-slate-800 border border-slate-600 rounded-lg w-[540px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-600">
          <h2 className="text-white font-semibold text-lg">Import Collection / Environment</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-600">
          {(['file', 'paste'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2.5 text-sm font-medium transition-colors ${
                tab === t
                  ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t === 'file' ? 'Upload File' : 'Paste JSON'}
            </button>
          ))}
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {tab === 'file' ? (
            <div
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-slate-600 hover:border-orange-500 rounded-lg p-10 text-center cursor-pointer transition-colors"
            >
              <div className="text-4xl mb-3">📂</div>
              <p className="text-slate-300 font-medium">Click to browse or drag & drop</p>
              <p className="text-slate-500 text-sm mt-1">Postman Collection v2.1 JSON or Environment JSON</p>
              <input
                ref={fileRef}
                type="file"
                accept=".json"
                multiple
                className="hidden"
                onChange={e => handleFiles(e.target.files)}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="text-slate-400 text-sm">Paste Postman Collection or Environment JSON:</label>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={12}
                className="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-100 text-sm font-mono resize-none focus:outline-none focus:border-orange-500"
                placeholder={'{\n  "info": { "name": "My Collection", ... },\n  "item": [...]\n}'}
              />
              <button
                onClick={() => parseAndImport(pasteText)}
                className="self-end px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded text-sm font-medium transition-colors"
              >
                Import
              </button>
            </div>
          )}

          {error && (
            <p className="mt-3 text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{error}</p>
          )}
          {success && (
            <p className="mt-3 text-green-400 text-sm bg-green-900/20 border border-green-700 rounded p-2">{success}</p>
          )}
        </div>
      </div>
    </div>
  );
}
