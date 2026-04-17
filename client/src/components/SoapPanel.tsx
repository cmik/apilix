import { useState } from 'react';
import { fetchWsdl } from '../api';
import { parseWsdl, buildEnvelope, defaultEnvelope } from '../utils/wsdlUtils';
import type { WsdlOperation } from '../utils/wsdlUtils';
import CodeEditor from './CodeEditor';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

// ─── Local helpers ────────────────────────────────────────────────────────────

function beautifyXml(xml: string): string {
  let indent = 0;
  return xml
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map(line => {
      line = line.trim();
      if (!line) return '';
      if (line.startsWith('</')) indent = Math.max(indent - 1, 0);
      const pad = '  '.repeat(indent);
      if (
        line.startsWith('<') &&
        !line.startsWith('</') &&
        !line.startsWith('<?') &&
        !line.endsWith('/>') &&
        !/<\/[^>]+>$/.test(line)
      ) indent++;
      return pad + line;
    })
    .filter(Boolean)
    .join('\n');
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface SoapPanelProps {
  envelope: string;
  action: string;
  version: '1.1' | '1.2';
  wsdlUrl: string;
  variableSuggestions?: VariableSuggestion[];
  onEnvelopeChange: (v: string) => void;
  onActionChange: (v: string) => void;
  onVersionChange: (v: '1.1' | '1.2') => void;
  onWsdlUrlChange: (v: string) => void;
}

export default function SoapPanel({
  envelope,
  action,
  version,
  wsdlUrl,
  variableSuggestions,
  onEnvelopeChange,
  onActionChange,
  onVersionChange,
  onWsdlUrlChange,
}: SoapPanelProps) {
  const [wsdlInput, setWsdlInput] = useState(wsdlUrl);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [operations, setOperations] = useState<WsdlOperation[]>([]);
  const [selectedOp, setSelectedOp] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  async function handleFetchWsdl() {
    const url = wsdlInput.trim();
    if (!url) return;
    setFetching(true);
    setFetchError('');
    setOperations([]);
    setSelectedOp('');
    try {
      const xml = await fetchWsdl(url);
      const ops = parseWsdl(xml);
      if (ops.length === 0) {
        setFetchError('No operations found in WSDL (or unsupported WSDL format).');
      } else {
        setOperations(ops);
        onWsdlUrlChange(url);
      }
    } catch (err: any) {
      setFetchError(err?.response?.data?.error ?? err?.message ?? 'Failed to fetch WSDL');
    } finally {
      setFetching(false);
    }
  }

  function handleSelectOperation(name: string) {
    setSelectedOp(name);
    const op = operations.find(o => o.name === name);
    if (!op) return;
    onActionChange(op.soapAction);
    onEnvelopeChange(buildEnvelope(op, version));
  }

  function handleVersionChange(v: '1.1' | '1.2') {
    onVersionChange(v);
    // Rebuild envelope from selected op if one is active, to use correct namespace
    if (selectedOp) {
      const op = operations.find(o => o.name === selectedOp);
      if (op) onEnvelopeChange(buildEnvelope(op, v));
    }
  }

  // Populate default envelope when first switching to soap mode
  const effectiveEnvelope =
    envelope || defaultEnvelope(version);

  return (
    <div className="flex flex-col gap-3">

      {/* ── Collapsible settings (version / action / WSDL) ── */}
      <div className="border border-slate-700 rounded overflow-hidden">
        <button
          type="button"
          onClick={() => setSettingsOpen(o => !o)}
          className="w-full flex items-center justify-between px-3 py-2 bg-slate-800/60 hover:bg-slate-800 transition-colors text-left"
        >
          <span className="text-xs font-medium text-slate-400">SOAP Settings</span>
          <svg
            className={`w-3.5 h-3.5 text-slate-500 transition-transform ${settingsOpen ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {settingsOpen && (
          <div className="flex flex-col gap-3 px-3 py-3 bg-slate-800/30">

            {/* Version + SOAPAction */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400 whitespace-nowrap">SOAP version</label>
                <select
                  value={version}
                  onChange={e => handleVersionChange(e.target.value as '1.1' | '1.2')}
                  className="bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs text-slate-300"
                >
                  <option value="1.1">1.1</option>
                  <option value="1.2">1.2</option>
                </select>
              </div>

              <div className="flex items-center gap-2 flex-1 min-w-0">
                <label className="text-xs text-slate-400 whitespace-nowrap">SOAPAction</label>
                <input
                  type="text"
                  value={action}
                  onChange={e => onActionChange(e.target.value)}
                  placeholder={version === '1.1' ? '"http://example.com/Action"' : 'Leave empty for SOAP 1.2 if not needed'}
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-600 rounded px-2 py-0.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500"
                />
              </div>
            </div>

            {/* WSDL */}
            <div className="flex flex-col gap-2">
              <p className="text-xs text-slate-400 font-medium">WSDL (optional)</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={wsdlInput}
                  onChange={e => setWsdlInput(e.target.value)}
                  placeholder="https://example.com/service?WSDL"
                  className="flex-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500"
                  onKeyDown={e => { if (e.key === 'Enter') handleFetchWsdl(); }}
                />
                <button
                  onClick={handleFetchWsdl}
                  disabled={fetching || !wsdlInput.trim()}
                  className="px-3 py-1 text-xs bg-orange-600 hover:bg-orange-500 disabled:bg-slate-600 disabled:text-slate-400 text-white rounded transition-colors whitespace-nowrap"
                >
                  {fetching ? 'Fetching…' : 'Fetch'}
                </button>
              </div>

              {fetchError && (
                <p className="text-xs text-red-400 font-mono">{fetchError}</p>
              )}

              {operations.length > 0 && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-400 whitespace-nowrap">Operation</label>
                  <select
                    value={selectedOp}
                    onChange={e => handleSelectOperation(e.target.value)}
                    className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs text-slate-200"
                  >
                    <option value="">— select an operation —</option>
                    {operations.map(op => (
                      <option key={op.name} value={op.name}>{op.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

          </div>
        )}
      </div>

      {/* ── Envelope textarea ── */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-slate-400">Envelope (XML)</label>
          <button
            onClick={() => onEnvelopeChange(beautifyXml(effectiveEnvelope))}
            className="text-xs text-slate-500 hover:text-orange-400 transition-colors"
          >
            Beautify
          </button>
        </div>
        <CodeEditor
          value={effectiveEnvelope}
          onChange={e => onEnvelopeChange(e.target.value)}
          rows={12}
          language="xml"
          variableSuggestions={variableSuggestions}
          placeholder={'<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope ...>'}
        />
      </div>
    </div>
  );
}
