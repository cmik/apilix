import { useState, useEffect, useRef } from 'react';
import { useApp } from '../store';
import type { AppSettings, ClientCertificate } from '../types';
import apilixLogo from '../assets/apilix1.svg';
import { fetchLatestGitHubVersion, isVersionGreater } from '../utils/versionUtils';

export type SettingsTab = 'appearance' | 'requests' | 'proxy' | 'cors' | 'shortcuts' | 'about';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'requests',   label: 'Requests'   },
  { key: 'proxy',      label: 'Proxy'      },
  { key: 'cors',       label: 'CORS'       },
  { key: 'shortcuts',  label: 'Shortcuts'  },
  { key: 'about',      label: 'About'      },
];

interface Props {
  onClose: () => void;
  initialTab?: SettingsTab;
}

// ─── Shared form helpers ──────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-slate-400 mb-1">{children}</label>;
}

function TextInput({
  value, onChange, placeholder, type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-orange-500 transition-colors"
    />
  );
}

function NumberInput({
  value, onChange, min, max, placeholder,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState(String(value));
  // Keep raw in sync when external value changes (e.g. on reset)
  useEffect(() => { setRaw(String(value)); }, [value]);
  return (
    <input
      type="number"
      value={raw}
      min={min}
      max={max}
      onChange={e => {
        setRaw(e.target.value);
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) {
          onChange(n);
        }
      }}
      onBlur={() => {
        // Snap back to last valid value when field is left empty or out of range
        const n = parseInt(raw, 10);
        if (isNaN(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
          setRaw(String(value));
        }
      }}
      placeholder={placeholder}
      className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-orange-500 transition-colors"
    />
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex w-9 h-5 items-center rounded-full transition-colors ${
        checked ? 'bg-orange-500' : 'bg-slate-700'
      }`}
    >
      <span
        className={`inline-block w-3.5 h-3.5 bg-white rounded-full shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-slate-300">{label}</span>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function AppearanceTab({ s, u }: { s: AppSettings; u: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="space-y-5">
      <Section title="Theme">
        <div className="flex gap-2">
          {(['dark', 'light', 'system'] as const).map(t => (
            <button
              key={t}
              onClick={() => u({ theme: t })}
              className={`flex-1 py-2 rounded text-sm font-medium border transition-colors capitalize ${
                (s.theme ?? 'dark') === t
                  ? 'border-orange-500 text-orange-400 bg-orange-500/10'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
              }`}
            >
              {t === 'dark' ? '🌙 Dark' : t === 'light' ? '☀️ Light' : '🖥 System'}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Request Layout">
        <div className="flex gap-2">
          {(['stacked', 'split'] as const).map(layout => (
            <button
              key={layout}
              onClick={() => u({ requestLayout: layout })}
              className={`flex-1 py-2 rounded text-sm font-medium border transition-colors ${
                (s.requestLayout ?? 'stacked') === layout
                  ? 'border-orange-500 text-orange-400 bg-orange-500/10'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
              }`}
            >
              {layout === 'stacked' ? '⬜ Stacked' : '◫ Split'}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Workspace Behavior">
        <Row label="Restore tabs on workspace switch / restart">
          <Toggle checked={s.restoreTabsOnSwitch === true} onChange={v => u({ restoreTabsOnSwitch: v })} />
        </Row>
      </Section>

    </div>
  );
}

function RequestsTab({ s, u }: { s: AppSettings; u: (p: Partial<AppSettings>) => void }) {
  const caFileInputRef = useRef<HTMLInputElement>(null);
  const certFileInputRef = useRef<HTMLInputElement>(null);
  const keyFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingLoad, setPendingLoad] = useState<{ idx: number; field: 'cert' | 'key' } | null>(null);
  const eAPI = (window as any).electronAPI ?? null;

  // ── Custom CA loaders ──────────────────────────────────────────────────────

  async function handleLoadCertFile() {
    if (eAPI?.openFileDialog) {
      try {
        const filePath: string | null = await eAPI.openFileDialog([
          { name: 'Certificate files', extensions: ['pem', 'crt', 'cer', 'ca-bundle', 'txt'] },
          { name: 'All files', extensions: ['*'] },
        ]);
        if (!filePath) return;
        const content: string = await eAPI.readTextFile(filePath);
        u({ customCAs: content });
      } catch (error) {
        console.error('Failed to load certificate file:', error);
        window.alert('Failed to load the certificate file. Please check the file permissions/size and try again.');
      }
    } else {
      caFileInputRef.current?.click();
    }
  }

  function handleBrowserFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { u({ customCAs: ev.target?.result as string ?? '' }); };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ── Client certificate loaders ─────────────────────────────────────────────

  function updateCertEntry(idx: number, patch: Partial<ClientCertificate>) {
    const list = [...(s.clientCertificates ?? [])];
    if (idx < 0 || idx >= list.length || !list[idx]) return;
    list[idx] = { ...list[idx], ...patch };
    u({ clientCertificates: list });
  }

  async function handleLoadClientFile(idx: number, field: 'cert' | 'key') {
    if (eAPI?.openFileDialog) {
      const filePath: string | null = await eAPI.openFileDialog([
        { name: 'PEM files', extensions: ['pem', 'crt', 'cer', 'key', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ]);
      if (!filePath) return;
      const content: string = await eAPI.readTextFile(filePath);
      updateCertEntry(idx, { [field]: content });
    } else {
      setPendingLoad({ idx, field });
      if (field === 'cert') certFileInputRef.current?.click();
      else keyFileInputRef.current?.click();
    }
  }

  function handleClientBrowserFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !pendingLoad) return;
    const { idx, field } = pendingLoad;
    const reader = new FileReader();
    reader.onload = ev => { updateCertEntry(idx, { [field]: ev.target?.result as string ?? '' }); };
    reader.readAsText(file);
    e.target.value = '';
    setPendingLoad(null);
  }

  function addCertEntry() {
    const list = [...(s.clientCertificates ?? [])];
    list.push({ host: '*', cert: '', key: '', passphrase: '', enabled: true });
    u({ clientCertificates: list });
  }

  function removeCertEntry(idx: number) {
    const list = (s.clientCertificates ?? []).filter((_, i) => i !== idx);
    u({ clientCertificates: list });
  }

  const clientCerts = s.clientCertificates ?? [];

  return (
    <div className="space-y-5">
      <Section title="Defaults">
        <div>
          <Label>Request timeout (ms) — 0 means no timeout</Label>
          <NumberInput
            value={s.requestTimeout ?? 30000}
            onChange={v => u({ requestTimeout: v })}
            min={0}
            placeholder="30000"
          />
        </div>
        <Row label="Follow redirects">
          <Toggle checked={s.followRedirects !== false} onChange={v => u({ followRedirects: v })} />
        </Row>
        <Row label="SSL certificate verification">
          <Toggle checked={s.sslVerification === true} onChange={v => u({ sslVerification: v })} />
        </Row>
      </Section>

      <Section title="Custom CA Certificates">
        <p className="text-xs text-slate-400 leading-relaxed">
          Paste or load one or more PEM-encoded CA certificates to trust when SSL verification is enabled.
          Useful for corporate / self-signed root CAs not present in the system store.
          Multiple certificates can be concatenated.
        </p>
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label>PEM certificate(s)</Label>
            <div className="flex gap-2 mb-1">
              <button
                type="button"
                onClick={handleLoadCertFile}
                className="px-2 py-0.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors"
              >
                Load from file…
              </button>
              {(s.customCAs ?? '').trim() && (
                <button
                  type="button"
                  onClick={() => u({ customCAs: '' })}
                  className="px-2 py-0.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-400 hover:text-red-400 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <textarea
            value={s.customCAs ?? ''}
            onChange={e => u({ customCAs: e.target.value })}
            placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
            rows={6}
            spellCheck={false}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-orange-500 transition-colors resize-y"
          />
          {(s.customCAs ?? '').trim() && (
            <p className="mt-1 text-[10px] text-green-400">
              {(s.customCAs!.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length} certificate(s) loaded
              {!s.sslVerification && <span className="text-yellow-400"> — enable SSL verification for these CAs to take effect</span>}
            </p>
          )}
          {/* Hidden file input for browser mode */}
          <input
            ref={caFileInputRef}
            type="file"
            accept=".pem,.crt,.cer,.ca-bundle,.txt"
            onChange={handleBrowserFileChange}
            className="hidden"
          />
        </div>
      </Section>

      <Section title="Client Certificates (mTLS)">
        <p className="text-xs text-slate-400 leading-relaxed">
          Client certificates authenticate this application to servers that require mutual TLS.
          Entries are matched by hostname (exact or <span className="font-mono">*.wildcard</span>).
          Certificate and key must be PEM-encoded.
        </p>

        {/* Hidden file inputs for browser fallback */}
        <input ref={certFileInputRef} type="file" accept=".pem,.crt,.cer,.txt" onChange={handleClientBrowserFileChange} className="hidden" />
        <input ref={keyFileInputRef}  type="file" accept=".pem,.key,.txt"      onChange={handleClientBrowserFileChange} className="hidden" />

        {clientCerts.length > 0 && (
          <div className="flex flex-col gap-3">
            {clientCerts.map((entry, idx) => (
              <div key={idx} className="border border-slate-700 rounded-md overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-800 border-b border-slate-700">
                  <button
                    type="button"
                    onClick={() => updateCertEntry(idx, { enabled: entry.enabled === false })}
                    className={`relative inline-flex w-8 h-4 items-center rounded-full transition-colors shrink-0 ${
                      entry.enabled !== false ? 'bg-orange-500' : 'bg-slate-600'
                    }`}
                    title={entry.enabled !== false ? 'Enabled' : 'Disabled'}
                  >
                    <span className={`inline-block w-3 h-3 bg-white rounded-full shadow transition-transform ${
                      entry.enabled !== false ? 'translate-x-4' : 'translate-x-0.5'
                    }`} />
                  </button>
                  <input
                    type="text"
                    value={entry.host}
                    onChange={e => updateCertEntry(idx, { host: e.target.value })}
                    placeholder="api.example.com or *.internal.corp"
                    className="flex-1 bg-transparent text-xs text-slate-200 placeholder-slate-500 focus:outline-none min-w-0"
                  />
                  <button
                    type="button"
                    onClick={() => removeCertEntry(idx)}
                    title="Remove entry"
                    className="text-slate-500 hover:text-red-400 transition-colors shrink-0"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>

                {/* Fields */}
                <div className="px-3 py-2 space-y-2">
                  {/* Certificate */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 w-14 shrink-0">CERT</span>
                    <span className={`text-[10px] flex-1 font-mono truncate ${entry.cert.trim() ? 'text-green-400' : 'text-slate-600'}`}>
                      {entry.cert.trim()
                        ? `${(entry.cert.match(/-----BEGIN[^-]+-----/g) ?? []).length} cert block(s) loaded`
                        : 'not set'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleLoadClientFile(idx, 'cert')}
                      className="px-2 py-0.5 text-[10px] rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors shrink-0"
                    >
                      Load…
                    </button>
                    {entry.cert.trim() && (
                      <button type="button" onClick={() => updateCertEntry(idx, { cert: '' })} className="text-slate-500 hover:text-red-400 transition-colors">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    )}
                  </div>

                  {/* Key */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 w-14 shrink-0">KEY</span>
                    <span className={`text-[10px] flex-1 font-mono truncate ${entry.key.trim() ? 'text-green-400' : 'text-slate-600'}`}>
                      {entry.key.trim() ? 'loaded' : 'not set'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleLoadClientFile(idx, 'key')}
                      className="px-2 py-0.5 text-[10px] rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors shrink-0"
                    >
                      Load…
                    </button>
                    {entry.key.trim() && (
                      <button type="button" onClick={() => updateCertEntry(idx, { key: '' })} className="text-slate-500 hover:text-red-400 transition-colors">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    )}
                  </div>

                  {/* Passphrase */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 w-14 shrink-0">PASS</span>
                    <input
                      type="password"
                      value={entry.passphrase ?? ''}
                      onChange={e => updateCertEntry(idx, { passphrase: e.target.value })}
                      placeholder="Key passphrase (optional)"
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-orange-500"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={addCertEntry}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add entry
        </button>
      </Section>

      <Section title="Security">
        <Row label="Mask secret variable values in console, logs, and history">
          <Toggle checked={s.maskSecrets !== false} onChange={v => u({ maskSecrets: v })} />
        </Row>
      </Section>
    </div>
  );
}

function ProxyTab({ s, u }: { s: AppSettings; u: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="space-y-5">
      <Section title="Proxy">
        <Row label="Enable proxy">
          <Toggle checked={s.proxyEnabled === true} onChange={v => u({ proxyEnabled: v })} />
        </Row>
        <div className={s.proxyEnabled ? '' : 'opacity-40 pointer-events-none'}>
          <div className="space-y-3">
            <div>
              <Label>HTTP Proxy URL</Label>
              <TextInput
                value={s.httpProxy ?? ''}
                onChange={v => u({ httpProxy: v })}
                placeholder="http://proxy.example.com:8080"
              />
            </div>
            <div>
              <Label>HTTPS Proxy URL</Label>
              <TextInput
                value={s.httpsProxy ?? ''}
                onChange={v => u({ httpsProxy: v })}
                placeholder="http://proxy.example.com:8080"
              />
            </div>
            <div>
              <Label>No proxy (comma-separated hosts)</Label>
              <TextInput
                value={s.noProxy ?? ''}
                onChange={v => u({ noProxy: v })}
                placeholder="localhost, 127.0.0.1, .internal.example.com"
              />
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function CorsTab({ s, u }: { s: AppSettings; u: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="space-y-5">
      <Section title="Allowed Origins">
        <p className="text-xs text-slate-400 leading-relaxed">
          Additional origins the local API server will accept requests from (comma-separated).
          The default localhost-only rule always applies. Use this for custom domains or ports.
        </p>
        <div>
          <Label>Allowed origins</Label>
          <textarea
            value={s.corsAllowedOrigins ?? ''}
            onChange={e => u({ corsAllowedOrigins: e.target.value })}
            placeholder="https://app.example.com, http://custom.host:5000"
            rows={4}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-orange-500 transition-colors resize-none"
          />
        </div>
      </Section>
    </div>
  );
}

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error';

function AboutTab() {
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—';
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function checkForUpdate() {
    setUpdateStatus('checking');
    try {
      const latest = await fetchLatestGitHubVersion(AbortSignal.timeout(10000));
      if (!mountedRef.current) return;
      setLatestVersion(latest);
      setUpdateStatus(isVersionGreater(latest, version) ? 'update-available' : 'up-to-date');
    } catch {
      if (!mountedRef.current) return;
      setUpdateStatus('error');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 pb-4 border-b border-slate-800">
        <img src={apilixLogo} alt="Apilix" className="w-12 h-12 object-contain" />
        <div>
          <div className="text-base font-semibold text-slate-200">Apilix</div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Version {version}</span>
            {updateStatus === 'idle' || updateStatus === 'error' ? (
              <button
                onClick={checkForUpdate}
                className="text-xs text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                {updateStatus === 'error' ? 'Retry' : 'Check for update'}
              </button>
            ) : updateStatus === 'checking' ? (
              <span className="text-xs text-slate-500 flex items-center gap-1">
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                Checking…
              </span>
            ) : updateStatus === 'up-to-date' ? (
              <span className="text-xs text-green-400 flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                Up to date
              </span>
            ) : (
              <a
                href="https://github.com/cmik/apilix/releases/latest"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-amber-400 hover:text-amber-300 transition-colors flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                v{latestVersion} available
              </a>
            )}
            {updateStatus === 'error' && (
              <span className="text-xs text-red-400">Could not reach GitHub.</span>
            )}
          </div>
        </div>
      </div>
      <Section title="Links">
        <div className="flex items-center gap-3">
          <a
            href="https://github.com/cmik/apilix"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-orange-400 hover:text-orange-300 transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            GitHub
          </a>
          <a
            href="https://github.com/cmik/apilix/wiki"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-orange-400 hover:text-orange-300 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
            </svg>
            Wiki
          </a>
        </div>
      </Section>
    </div>
  );
}

// ─── Shortcuts Tab ───────────────────────────────────────────────────────────

const SHORTCUTS_LIST: { keys: string[]; description: string; condition?: string }[] = [
  { keys: ['Ctrl', 'Enter'],      description: 'Send request',              condition: 'Request view' },
  { keys: ['Ctrl', 'S'],          description: 'Save request',              condition: 'Request view' },
  { keys: ['Ctrl', 'Shift', 'S'], description: 'Quick sync',                condition: 'Sync configured' },
  { keys: ['Ctrl', 'L'],          description: 'Focus URL field',           condition: 'Request view' },
  { keys: ['Ctrl', 'N'],          description: 'New request',               condition: '' },
  { keys: ['Ctrl', 'W'],          description: 'Close active tab',          condition: '' },
  { keys: ['Ctrl', 'E'],          description: 'Open environments panel',   condition: '' },
  { keys: ['Ctrl', 'Shift', 'M'], description: 'Open workspace manager',    condition: '' },
  { keys: ['Ctrl', 'Shift', 'K'], description: 'Open keyboard shortcuts',   condition: '' },
];

function ShortcutsTab() {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().startsWith('MAC');
  function labelKey(k: string): string {
    if (!isMac) return k;
    if (k === 'Ctrl')  return '⌘';
    if (k === 'Shift') return '⇧';
    return k;
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-slate-500 mb-4">All keyboard shortcuts available in Apilix.</p>
      <div className="divide-y divide-slate-800">
        {SHORTCUTS_LIST.map((shortcut, i) => (
          <div key={i} className="flex items-center justify-between py-2.5 gap-4">
            <div className="flex items-center gap-1.5">
              {shortcut.keys.map((k, j) => (
                <kbd
                  key={j}
                  className="inline-flex items-center justify-center min-w-[28px] h-6 px-1.5 bg-slate-800 border border-slate-600 rounded text-[11px] font-mono text-slate-200 leading-none"
                >
                  {labelKey(k)}
                </kbd>
              ))}
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm text-slate-300 truncate">{shortcut.description}</span>
              {shortcut.condition && (
                <span className="shrink-0 text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                  {shortcut.condition}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export default function SettingsModal({ onClose, initialTab }: Props) {
  const { state, dispatch } = useApp();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'appearance');

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  const settings = state.settings;
  function update(patch: Partial<AppSettings>) {
    dispatch({ type: 'UPDATE_SETTINGS', payload: patch });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[680px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 shrink-0">
          <h2 className="text-sm font-semibold text-slate-200">Settings</h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-slate-800 px-4 shrink-0">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.key
                  ? 'border-orange-500 text-orange-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'appearance' && <AppearanceTab s={settings} u={update} />}
          {activeTab === 'requests'   && <RequestsTab   s={settings} u={update} />}
          {activeTab === 'proxy'      && <ProxyTab      s={settings} u={update} />}
          {activeTab === 'cors'       && <CorsTab       s={settings} u={update} />}
          {activeTab === 'shortcuts'  && <ShortcutsTab />}
          {activeTab === 'about'      && <AboutTab />}
        </div>
      </div>
    </div>
  );
}
