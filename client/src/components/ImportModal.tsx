import { useState, useRef } from 'react';
import { useApp, parseCollectionFile, parseEnvironmentFile, generateId } from '../store';
import { parseCurlCommand } from '../utils/curlUtils';
import type { PostmanItem, PostmanAuth, PostmanBody } from '../types';

interface ImportModalProps {
  onClose: () => void;
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : u.hostname;
  } catch {
    return 'Imported Request';
  }
}

export default function ImportModal({ onClose }: ImportModalProps) {
  const { state, dispatch } = useApp();
  const [tab, setTab] = useState<'file' | 'paste' | 'curl'>('file');
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [curlText, setCurlText] = useState('');
  const [curlError, setCurlError] = useState<string | null>(null);
  const [curlSuccess, setCurlSuccess] = useState<string | null>(null);
  const [targetCollectionId, setTargetCollectionId] = useState<string>(
    state.collections[0]?._id ?? ''
  );

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

  function handleCurlImport() {
    setCurlError(null);
    setCurlSuccess(null);
    const parsed = parseCurlCommand(curlText);
    if (!parsed) {
      setCurlError('Could not parse cURL command. Make sure it starts with "curl".');
      return;
    }
    const col = state.collections.find(c => c._id === targetCollectionId);
    if (!col) {
      setCurlError('Please select a target collection.');
      return;
    }

    const auth: PostmanAuth | undefined = parsed.authType === 'basic'
      ? {
          type: 'basic',
          basic: [
            { key: 'username', value: parsed.authBasicUser },
            { key: 'password', value: parsed.authBasicPass },
          ],
        }
      : undefined;

    const body: PostmanBody | undefined = parsed.bodyMode !== 'none'
      ? {
          mode: parsed.bodyMode,
          raw: parsed.bodyMode === 'raw' ? parsed.bodyRaw : undefined,
          urlencoded: parsed.bodyMode === 'urlencoded' ? parsed.bodyUrlEncoded : undefined,
          formdata: parsed.bodyMode === 'formdata' ? parsed.bodyFormData : undefined,
          options: parsed.bodyMode === 'raw' ? { raw: { language: parsed.bodyRawLang } } : undefined,
        }
      : undefined;

    const newItem: PostmanItem = {
      id: generateId(),
      name: nameFromUrl(parsed.url),
      request: {
        method: parsed.method,
        url: { raw: parsed.url },
        header: parsed.headers.map(h => ({ key: h.key, value: h.value })),
        body,
        auth,
      },
    };

    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: [...col.item, newItem] } });
    setCurlSuccess(`Request "${newItem.name}" added to "${col.info.name}".`);
    setCurlText('');
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-slate-800 border border-slate-600 rounded-lg w-[540px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-600">
          <h2 className="text-white font-semibold text-lg">Import</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-600">
          {(['file', 'paste', 'curl'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2.5 text-sm font-medium transition-colors ${
                tab === t
                  ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t === 'file' ? 'Upload File' : t === 'paste' ? 'Paste JSON' : 'Paste cURL'}
            </button>
          ))}
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {tab === 'file' && (
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
          )}

          {tab === 'paste' && (
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

          {tab === 'curl' && (
            <div className="flex flex-col gap-3">
              {state.collections.length === 0 ? (
                <p className="text-amber-400 text-sm bg-amber-900/20 border border-amber-700 rounded p-3">
                  No collections found. Create a collection first, then import a cURL command into it.
                </p>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-slate-400 text-sm">Target collection</label>
                    <select
                      value={targetCollectionId}
                      onChange={e => setTargetCollectionId(e.target.value)}
                      className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                    >
                      {state.collections.map(c => (
                        <option key={c._id} value={c._id}>{c.info.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-slate-400 text-sm">Paste cURL command</label>
                    <textarea
                      value={curlText}
                      onChange={e => { setCurlText(e.target.value); setCurlError(null); setCurlSuccess(null); }}
                      rows={11}
                      spellCheck={false}
                      className="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-100 text-sm font-mono resize-none focus:outline-none focus:border-orange-500"
                      placeholder={"curl -X POST https://api.example.com/users \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"name\": \"Alice\"}'"}
                    />
                  </div>
                  {curlError && (
                    <p className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{curlError}</p>
                  )}
                  {curlSuccess && (
                    <p className="text-green-400 text-sm bg-green-900/20 border border-green-700 rounded p-2">{curlSuccess}</p>
                  )}
                  <button
                    onClick={handleCurlImport}
                    className="self-end px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded text-sm font-medium transition-colors"
                  >
                    Import
                  </button>
                </>
              )}
            </div>
          )}

          {tab !== 'curl' && error && (
            <p className="mt-3 text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{error}</p>
          )}
          {tab !== 'curl' && success && (
            <p className="mt-3 text-green-400 text-sm bg-green-900/20 border border-green-700 rounded p-2">{success}</p>
          )}
        </div>
      </div>
    </div>
  );
}
