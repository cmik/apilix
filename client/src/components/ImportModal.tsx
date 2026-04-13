import { useState, useRef } from 'react';
import { useApp, parseCollectionFile, parseEnvironmentFile, generateId } from '../store';
import { parseCurlCommand } from '../utils/curlUtils';
import { parseHurlFile, HURL_METHOD_REGEX } from '../utils/hurlUtils';
import { parseOpenApiSpec } from '../utils/openApiUtils';
import { parseHarFile } from '../utils/harUtils';
import { useToast } from './Toast';
import type { CollectionItem, CollectionAuth, CollectionBody } from '../types';

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
  const toast = useToast();
  const [tab, setTab] = useState<'file' | 'url' | 'paste' | 'curl' | 'hurl' | 'openapi' | 'har'>('file');
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [curlText, setCurlText] = useState('');
  const [curlError, setCurlError] = useState<string | null>(null);
  const [hurlText, setHurlText] = useState('');
  const [hurlError, setHurlError] = useState<string | null>(null);
  const [openApiText, setOpenApiText] = useState('');
  const [openApiUrl, setOpenApiUrl] = useState('');
  const [openApiError, setOpenApiError] = useState<string | null>(null);
  const [openApiLoading, setOpenApiLoading] = useState(false);
  const openApiFileRef = useRef<HTMLInputElement>(null);
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlLoading, setUrlLoading] = useState(false);
  const [harText, setHarText] = useState('');
  const [harError, setHarError] = useState<string | null>(null);
  const [targetCollectionId, setTargetCollectionId] = useState<string>(
    state.collections[0]?._id ?? ''
  );

  function parseAndImport(text: string, filename?: string) {
    setError(null);
    // Detect OpenAPI / Swagger files by extension or content
    const isOpenApiFile =
      filename?.toLowerCase().endsWith('.yaml') ||
      filename?.toLowerCase().endsWith('.yml') ||
      (filename?.toLowerCase().endsWith('.json') && (() => {
        try { const j = JSON.parse(text); return !!(j.openapi || j.swagger); } catch { return false; }
      })());

    if (isOpenApiFile) {
      try {
        const { collectionName, items, collectionAuth } = parseOpenApiSpec(text, filename);
        const newColId = generateId();
        dispatch({
          type: 'ADD_COLLECTION',
          payload: {
            _id: newColId,
            info: {
              name: collectionName,
              schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            },
            item: items,
            ...(collectionAuth && { auth: collectionAuth }),
          },
        });
        const total = items.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
        toast.success(`Collection "${collectionName}" with ${total} request(s) imported!`);
        onClose();
      } catch (e) {
        const msg = `OpenAPI parse error: ${(e as Error).message}`;
        setError(msg); toast.error(msg);
      }
      return;
    }

    // Detect HAR files by extension or log.entries structure
    const isHarFile =
      filename?.toLowerCase().endsWith('.har') ||
      (!filename && (() => { try { const j = JSON.parse(text); return !!(j?.log?.entries); } catch { return false; } })());
    if (isHarFile) {
      try {
        const items = parseHarFile(text);
        if (items.length === 0) {
          setError('No requests found in HAR file.'); toast.error('No requests found in HAR file.');
          return;
        }
        const newColId = generateId();
        const colName = filename ? filename.replace(/\.har$/i, '') : 'HAR Import';
        dispatch({
          type: 'ADD_COLLECTION',
          payload: {
            _id: newColId,
            info: {
              name: colName,
              schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            },
            item: items,
          },
        });
        const total = items.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
        toast.success(`Collection "${colName}" with ${total} request(s) imported!`);
        onClose();
      } catch (e) {
        const msg = `HAR parse error: ${(e as Error).message}`;
        setError(msg); toast.error(msg);
      }
      return;
    }

    // Detect HURL files by extension or try parsing as HURL first if it looks like one
    const isHurlFile = filename?.toLowerCase().endsWith('.hurl');
    if (isHurlFile || (!text.trimStart().startsWith('{') && HURL_METHOD_REGEX.test(text))) {
      const col = state.collections.find(c => c._id === targetCollectionId);
      const items = parseHurlFile(text);
      if (items.length === 0) {
        if (!isHurlFile) {
          // Fall through to JSON parsing
        } else {
          setError('No valid HURL requests found in file.');
          return;
        }
      } else {
        if (col) {
          dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: [...col.item, ...items] } });
          toast.success(`${items.length} request(s) from HURL file added to "${col.info.name}".`);
          onClose();
        } else {
          // Create a new collection from HURL
          const newColId = generateId();
          const colName = filename ? filename.replace(/\.hurl$/i, '') : 'HURL Import';
          dispatch({
            type: 'ADD_COLLECTION',
            payload: {
              _id: newColId,
              info: {
                name: colName,
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
              },
              item: items,
            },
          });
          toast.success(`Collection "${colName}" with ${items.length} request(s) imported!`);
          onClose();
        }
        return;
      }
    }
    try {
      const json = JSON.parse(text);
      if (json.info && json.item) {
        const { collection: col, version, validationWarnings } = parseCollectionFile(json);
        dispatch({ type: 'ADD_COLLECTION', payload: col });
        const versionLabel = `Postman Collection v${version}`;
        if (validationWarnings.length > 0) {
          toast.warning(`"${col.info.name}" imported as ${versionLabel} with ${validationWarnings.length} schema warning(s):\n• ${validationWarnings.join('\n• ')}`, 8000);
        } else {
          toast.success(`"${col.info.name}" imported as ${versionLabel}.`);
        }
        onClose();
      } else if (json.name && Array.isArray(json.values)) {
        const env = parseEnvironmentFile(json);
        dispatch({ type: 'ADD_ENVIRONMENT', payload: env });
        toast.success(`Environment "${env.name}" imported!`);
        onClose();
      } else if (json.openapi || json.swagger) {
        // OpenAPI/Swagger JSON pasted into the paste tab
        try {
          const { collectionName, items, collectionAuth } = parseOpenApiSpec(text);
          const newColId = generateId();
          dispatch({
            type: 'ADD_COLLECTION',
            payload: {
              _id: newColId,
              info: {
                name: collectionName,
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
              },
              item: items,
              ...(collectionAuth && { auth: collectionAuth }),
            },
          });
          const total = items.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
          toast.success(`Collection "${collectionName}" with ${total} request(s) imported!`);
          onClose();
        } catch (e) {
          const msg = `OpenAPI parse error: ${(e as Error).message}`;
          setError(msg); toast.error(msg);
        }
      } else {
        const msg = 'Unrecognised format. Expected a Postman Collection v2.1, Environment JSON, HURL, or OpenAPI/Swagger spec.';
        setError(msg); toast.error(msg);
      }
    } catch (e) {
      const msg = `Invalid JSON: ${(e as Error).message}`;
      setError(msg); toast.error(msg);
    }
  }

  async function handleUrlImport() {
    setUrlError(null);
    if (!urlInput.trim()) {
      setUrlError('Please enter a URL.');
      return;
    }
    let url: string;
    try {
      url = new URL(urlInput.trim()).toString();
    } catch {
      setUrlError('Invalid URL.');
      return;
    }
    setUrlLoading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const text = await response.text();
      const filename = new URL(url).pathname.split('/').pop() || '';
      parseAndImport(text, filename);
    } catch (e) {
      const msg = `Failed to fetch: ${(e as Error).message}`;
      setUrlError(msg); toast.error(msg);
    } finally {
      setUrlLoading(false);
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        const text = e.target?.result as string;
        parseAndImport(text, file.name);
      };
      reader.readAsText(file);
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }

  function handleHurlImport() {
    setHurlError(null);
    const items = parseHurlFile(hurlText);
    if (items.length === 0) {
      setHurlError('No valid HURL requests found. Make sure each entry starts with a method line like "GET https://…".');
      return;
    }
    const col = state.collections.find(c => c._id === targetCollectionId);
    if (col) {
      dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: [...col.item, ...items] } });
      toast.success(`${items.length} request(s) added to "${col.info.name}".`);
      onClose();
    } else {
      // No collections yet — create one
      const newColId = generateId();
      dispatch({
        type: 'ADD_COLLECTION',
        payload: {
          _id: newColId,
          info: {
            name: 'HURL Import',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: items,
        },
      });
      toast.success(`Collection "HURL Import" with ${items.length} request(s) created.`);
      onClose();
    }
    setHurlText('');
  }

  function handleHarImport() {
    setHarError(null);
    try {
      const items = parseHarFile(harText);
      if (items.length === 0) {
        setHarError('No requests found in the HAR data.');
        return;
      }
      const newColId = generateId();
      dispatch({
        type: 'ADD_COLLECTION',
        payload: {
          _id: newColId,
          info: {
            name: 'HAR Import',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: items,
        },
      });
      const total = items.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
      toast.success(`Collection "HAR Import" with ${total} request(s) created.`);
      setHarText('');
      onClose();
    } catch (e) {
      const msg = `${(e as Error).message}`;
      setHarError(msg); toast.error(msg);
    }
  }

  async function handleOpenApiUrlImport() {
    setOpenApiError(null);

    if (!openApiUrl.trim()) {
      setOpenApiError('Please enter a URL.');
      return;
    }

    setOpenApiLoading(true);
    try {
      const response = await fetch(openApiUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type') || '';
      let spec: string;
      
      if (contentType.includes('application/json')) {
        const json = await response.json();
        spec = JSON.stringify(json);
      } else {
        spec = await response.text();
      }

      const { collectionName, items, collectionAuth } = parseOpenApiSpec(spec);
      const newColId = generateId();
      dispatch({
        type: 'ADD_COLLECTION',
        payload: {
          _id: newColId,
          info: {
            name: collectionName,
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: items,
          ...(collectionAuth && { auth: collectionAuth }),
        },
      });
      const total = items.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
      toast.success(`Collection "${collectionName}" with ${total} request(s) imported!`);
      setOpenApiUrl('');
      onClose();
    } catch (e) {
      const msg = `Failed to import from URL: ${(e as Error).message}`;
      setOpenApiError(msg); toast.error(msg);
    } finally {
      setOpenApiLoading(false);
    }
  }

  function handleCurlImport() {
    setCurlError(null);
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

    const auth: CollectionAuth | undefined = parsed.authType === 'basic'
      ? {
          type: 'basic',
          basic: [
            { key: 'username', value: parsed.authBasicUser },
            { key: 'password', value: parsed.authBasicPass },
          ],
        }
      : undefined;

    const body: CollectionBody | undefined = parsed.bodyMode !== 'none'
      ? {
          mode: parsed.bodyMode,
          raw: parsed.bodyMode === 'raw' ? parsed.bodyRaw : undefined,
          urlencoded: parsed.bodyMode === 'urlencoded' ? parsed.bodyUrlEncoded : undefined,
          formdata: parsed.bodyMode === 'formdata' ? parsed.bodyFormData : undefined,
          options: parsed.bodyMode === 'raw' ? { raw: { language: parsed.bodyRawLang } } : undefined,
        }
      : undefined;

    const newItem: CollectionItem = {
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
    toast.success(`Request "${newItem.name}" added to "${col.info.name}".`);
    setCurlText('');
    onClose();
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
        <div className="flex border-b border-slate-600 overflow-x-auto">
          {(['file', 'url', 'paste', 'curl', 'hurl', 'openapi', 'har'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                tab === t
                  ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t === 'file' ? 'Upload File' : t === 'url' ? 'URL' : t === 'paste' ? 'JSON' : t === 'curl' ? 'cURL' : t === 'hurl' ? 'HURL' : t === 'openapi' ? 'OpenAPI' : 'HAR'}
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
              <p className="text-slate-500 text-sm mt-1">Postman Collection v2.1 JSON, Environment JSON, OpenAPI/Swagger (.yaml/.yml/.json), HURL (.hurl), or HAR (.har)</p>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.hurl,.yaml,.yml,.har"
                multiple
                className="hidden"
                onChange={e => handleFiles(e.target.files)}
              />
            </div>
          )}

          {tab === 'url' && (
            <div className="flex flex-col gap-3">
              <p className="text-slate-400 text-xs bg-slate-900/50 border border-slate-700 rounded p-2 leading-relaxed">
                Enter a public URL pointing to a Postman Collection, Environment JSON, OpenAPI/Swagger spec, HURL file, or HAR file.
              </p>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={urlInput}
                  onChange={e => { setUrlInput(e.target.value); setUrlError(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleUrlImport(); }}
                  placeholder="https://example.com/collection.json"
                  className="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-orange-500"
                />
                <button
                  onClick={handleUrlImport}
                  disabled={urlLoading}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-600 text-white rounded text-sm font-medium transition-colors whitespace-nowrap"
                >
                  {urlLoading ? 'Fetching…' : 'Import'}
                </button>
              </div>
              {urlError && (
                <p className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{urlError}</p>
              )}
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
                      onChange={e => { setCurlText(e.target.value); setCurlError(null); }}
                      rows={11}
                      spellCheck={false}
                      className="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-100 text-sm font-mono resize-none focus:outline-none focus:border-orange-500"
                      placeholder={"curl -X POST https://api.example.com/users \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"name\": \"Alice\"}'"}
                    />
                  </div>
                  {curlError && (
                    <p className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{curlError}</p>
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

          {tab === 'hurl' && (
            <div className="flex flex-col gap-3">
              <div className="text-slate-400 text-xs bg-slate-900/50 border border-slate-700 rounded p-2 leading-relaxed">
                Paste a <span className="text-orange-400 font-mono">HURL</span> file with one or more HTTP requests.
                Requests will be added to the selected collection (or a new one if none exists).
              </div>
              {state.collections.length > 0 && (
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
              )}
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-sm">Paste HURL content</label>
                <textarea
                  value={hurlText}
                  onChange={e => { setHurlText(e.target.value); setHurlError(null); }}
                  rows={11}
                  spellCheck={false}
                  className="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-100 text-sm font-mono resize-none focus:outline-none focus:border-orange-500"
                  placeholder={"GET https://api.example.com/users\nAuthorization: Bearer {{token}}\n\nHTTP *\n\n\nPOST https://api.example.com/users\nContent-Type: application/json\n\n{\"name\": \"Alice\"}\n\nHTTP *"}
                />
              </div>
              {hurlError && (
                <p className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{hurlError}</p>
              )}
              <button
                onClick={handleHurlImport}
                className="self-end px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded text-sm font-medium transition-colors"
              >
                Import
              </button>
            </div>
          )}

          {tab === 'openapi' && (
            <div className="flex flex-col gap-3">
              <div className="text-slate-400 text-xs bg-slate-900/50 border border-slate-700 rounded p-2 leading-relaxed">
                Paste an <span className="text-orange-400 font-mono">OpenAPI 3.x</span> or{' '}
                <span className="text-orange-400 font-mono">Swagger 2.0</span> spec (YAML or JSON).
                Each tagged group of endpoints becomes a folder in a new collection.
              </div>

              {/* Import from URL */}
              <div className="border-t border-slate-700 pt-3">
                <label className="text-slate-400 text-sm mb-2 block">Import from URL</label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={openApiUrl}
                    onChange={e => {
                      setOpenApiUrl(e.target.value);
                      setOpenApiError(null);
                    }}
                    placeholder="https://api.example.com/openapi.json"
                    className="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-orange-500"
                  />
                  <button
                    onClick={handleOpenApiUrlImport}
                    disabled={openApiLoading}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-600 text-white rounded text-sm font-medium transition-colors whitespace-nowrap"
                  >
                    {openApiLoading ? 'Fetching...' : 'Import'}
                  </button>
                </div>
              </div>

              {/* File & paste import */}
              <div className="border-t border-slate-700 pt-3">
                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => openApiFileRef.current?.click()}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm transition-colors"
                  >
                    Browse file
                  </button>
                  <input
                    ref={openApiFileRef}
                    type="file"
                    accept=".yaml,.yml,.json"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = ev => setOpenApiText(ev.target?.result as string);
                      reader.readAsText(file);
                    }}
                  />
                  <span className="text-slate-500 text-xs self-center">.yaml / .yml / .json</span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-slate-400 text-sm">Paste spec (YAML or JSON)</label>
                  <textarea
                    value={openApiText}
                    onChange={e => { setOpenApiText(e.target.value); setOpenApiError(null); }}
                    rows={10}
                    spellCheck={false}
                    className="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-100 text-sm font-mono resize-none focus:outline-none focus:border-orange-500"
                    placeholder={"openapi: 3.0.0\ninfo:\n  title: My API\n  version: 1.0.0\npaths:\n  /users:\n    get:\n      summary: List users\n      tags: [Users]"}
                  />
                </div>
                <button
                  onClick={() => {
                    setOpenApiError(null);
                    try {
                      const { collectionName, items, collectionAuth } = parseOpenApiSpec(openApiText);
                      const newColId = generateId();
                      dispatch({
                        type: 'ADD_COLLECTION',
                        payload: {
                          _id: newColId,
                          info: {
                            name: collectionName,
                            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
                          },
                          item: items,
                          ...(collectionAuth && { auth: collectionAuth }),
                        },
                      });
                      const total = items.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
                      toast.success(`Collection "${collectionName}" with ${total} request(s) imported!`);
                      setOpenApiText('');
                      onClose();
                    } catch (e) {
                      setOpenApiError(`Parse error: ${(e as Error).message}`);
                    }
                  }}
                  className="self-end px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded text-sm font-medium transition-colors"
                >
                  Import
                </button>
              </div>

              {openApiError && (
                <p className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{openApiError}</p>
              )}
            </div>
          )}

          {tab === 'har' && (
            <div className="flex flex-col gap-3">
              <div className="text-slate-400 text-xs bg-slate-900/50 border border-slate-700 rounded p-2 leading-relaxed">
                Paste or upload a <span className="text-orange-400 font-mono">.har</span> file exported from your browser's DevTools Network panel.
                Each captured request becomes a request in a new collection.
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-sm">Paste HAR JSON</label>
                <textarea
                  value={harText}
                  onChange={e => { setHarText(e.target.value); setHarError(null); }}
                  rows={12}
                  spellCheck={false}
                  className="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-100 text-sm font-mono resize-none focus:outline-none focus:border-orange-500"
                  placeholder={'{\n  "log": {\n    "entries": [\n      { "request": { "method": "GET", "url": "https://..." } }\n    ]\n  }\n}'}
                />
              </div>
              {harError && (
                <p className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{harError}</p>
              )}
              <button
                onClick={handleHarImport}
                className="self-end px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded text-sm font-medium transition-colors"
              >
                Import
              </button>
            </div>
          )}

          {tab !== 'curl' && tab !== 'hurl' && tab !== 'openapi' && tab !== 'har' && tab !== 'url' && error && (
            <p className="mt-3 text-red-400 text-sm bg-red-900/20 border border-red-700 rounded p-2">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
