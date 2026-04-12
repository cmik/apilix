import { useState, useEffect } from 'react';
import { useApp } from '../store';
import type { AppSettings } from '../types';
import apilixLogo from '../assets/apilix1.svg';

declare const __APP_VERSION__: string;

type Tab = 'appearance' | 'requests' | 'proxy' | 'cors' | 'about';

const TABS: { key: Tab; label: string }[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'requests',   label: 'Requests'   },
  { key: 'proxy',      label: 'Proxy'      },
  { key: 'cors',       label: 'CORS'       },
  { key: 'about',      label: 'About'      },
];

interface Props {
  onClose: () => void;
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

    </div>
  );
}

function RequestsTab({ s, u }: { s: AppSettings; u: (p: Partial<AppSettings>) => void }) {
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

  async function checkForUpdate() {
    setUpdateStatus('checking');
    try {
      const res = await fetch('https://api.github.com/repos/cmik/apilix/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const data = await res.json() as { tag_name: string };
      const latest = data.tag_name.replace(/^v/, '');
      setLatestVersion(latest);
      setUpdateStatus(latest === version ? 'up-to-date' : 'update-available');
    } catch {
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
        </div>
      </Section>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export default function SettingsModal({ onClose }: Props) {
  const { state, dispatch } = useApp();
  const [activeTab, setActiveTab] = useState<Tab>('appearance');

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
          {activeTab === 'about'      && <AboutTab />}
        </div>
      </div>
    </div>
  );
}
