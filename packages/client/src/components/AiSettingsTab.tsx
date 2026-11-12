import { useState } from 'react';
import { useApp } from '../store';
import { aiTest, toAiApiError } from '../api';
import type { AiFeatureKey, AiProviderKind, AppAction } from '../types';
import { AI_PROVIDER_DEFAULT_BASE, validateAiSettings } from '../utils/aiDefaults';
import { Label, TextInput, NumberInput, Toggle, Row, Section } from './settingsFormParts';
import AiConsentModal from './AiConsentModal';
import AiPreviewDialog from './AiPreviewDialog';

type AiSettingsPatch = Extract<AppAction, { type: 'AI_SET_SETTINGS' }>['payload'];

const PROVIDERS: { key: AiProviderKind; label: string }[] = [
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'openai-compat', label: 'OpenAI-compatible' },
];

const FEATURES: { key: AiFeatureKey; label: string }[] = [
  { key: 'nlGenerate', label: 'Generate requests and tests from a description' },
  { key: 'assertSuggest', label: 'Suggest assertions from a response' },
  { key: 'diagnose', label: 'Explain and diagnose failures' },
  { key: 'scriptAssist', label: 'Scripting assistant' },
  { key: 'docDescribe', label: 'Complete missing documentation descriptions' },
  { key: 'dataGen', label: 'Generate test data' },
  { key: 'smartImport', label: 'Smart import' },
];

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { electronAPI?: unknown }).electronAPI;
}

export default function AiSettingsTab() {
  const { state, dispatch, saveAiKey, syncAiConfig } = useApp();
  const { settings: s, keyStatus, inFlight, lastError } = state.ai;

  const [keyInput, setKeyInput] = useState('');
  const [remember, setRemember] = useState(true);
  const [showConsent, setShowConsent] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const validationError = validateAiSettings(s);
  const electron = isElectron();
  const testing = inFlight.test === true;
  const destination = s.baseUrl || (s.provider === 'anthropic' ? 'Anthropic' : 'the configured OpenAI-compatible endpoint');

  function update(patch: AiSettingsPatch) {
    dispatch({ type: 'AI_SET_SETTINGS', payload: patch });
    setTestResult(null);
  }

  function toggleEnabled(next: boolean) {
    if (next && !s.consentGiven) { setShowConsent(true); return; }
    update({ enabled: next });
  }

  async function handleSaveKey() {
    if (!keyInput.trim()) return;
    await saveAiKey(keyInput, { remember });
    setKeyInput('');
    setTestResult(null);
  }

  async function handleTest() {
    setTestResult(null);
    // A key typed but not yet saved would otherwise never reach the server.
    if (keyInput.trim()) {
      await saveAiKey(keyInput, { remember });
      setKeyInput('');
    }
    dispatch({ type: 'AI_REQUEST_START', payload: 'test' });
    try {
      let r;
      try {
        r = await aiTest();
      } catch (first) {
        // The server keeps the config in memory only: if it restarted since we pushed it, send it again once.
        const code = toAiApiError(first).code;
        if (!s.enabled || (code !== 'DISABLED' && code !== 'NO_PROVIDER')) throw first;
        try { await syncAiConfig(); } catch { /* the retry below reports the real error */ }
        r = await aiTest();
      }
      dispatch({ type: 'AI_REQUEST_DONE', payload: 'test' });
      setTestResult({ ok: true, text: `Connected · ${r.model} · ${r.latencyMs} ms` });
    } catch (err) {
      const e = toAiApiError(err);
      dispatch({ type: 'AI_REQUEST_FAIL', payload: { feature: 'test', code: e.code, message: e.message } });
      setTestResult({ ok: false, text: `${e.message} (${e.code})` });
    }
  }

  const keyStatusText: Record<typeof keyStatus, { text: string; tone: string }> = {
    none: { text: s.provider === 'openai-compat' ? 'No key saved (optional for local servers).' : 'No key saved.', tone: 'text-slate-500' },
    ok: {
      text: electron ? 'Key saved, encrypted with your OS keychain.' : 'Key saved in this browser’s localStorage, unencrypted.',
      tone: electron ? 'text-green-400' : 'text-orange-400',
    },
    'session-only': { text: 'Key kept in memory for this session only.', tone: 'text-slate-400' },
    'needs-reentry': { text: 'The stored key can’t be read on this installation. Enter it again.', tone: 'text-amber-400' },
    unavailable: { text: 'OS keychain unavailable: the key is kept in memory for this session only.', tone: 'text-amber-400' },
  };

  return (
    <div className="space-y-5">
      <Section title="AI features">
        <Row label="Enable AI features">
          <Toggle checked={s.enabled} onChange={toggleEnabled} />
        </Row>
        <p className="text-xs text-slate-500 leading-relaxed">
          Off by default. Nothing is sent anywhere until you enable this and use an AI feature.
        </p>
      </Section>

      <Section title="Provider">
        <div className="flex gap-2">
          {PROVIDERS.map(p => (
            <button
              key={p.key}
              onClick={() => update({ provider: p.key })}
              className={`flex-1 py-2 rounded text-sm font-medium border transition-colors ${
                s.provider === p.key
                  ? 'border-orange-500 text-orange-400 bg-orange-500/10'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div>
          <Label>Model</Label>
          <TextInput value={s.model} onChange={v => update({ model: v })} placeholder={s.provider === 'anthropic' ? 'e.g. claude-sonnet-5-5' : 'e.g. llama3.1'} />
        </div>
        <div>
          <Label>Base URL (optional)</Label>
          <TextInput value={s.baseUrl ?? ''} onChange={v => update({ baseUrl: v })} placeholder={AI_PROVIDER_DEFAULT_BASE[s.provider]} />
          {s.provider === 'openai-compat' && (
            <p className="text-[11px] text-slate-600 mt-1">Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1</p>
          )}
        </div>
        <div>
          <Label>API key</Label>
          <div className="flex gap-2">
            <div className="flex-1">
              <TextInput type="password" value={keyInput} onChange={setKeyInput} placeholder={keyStatus === 'ok' || keyStatus === 'session-only' ? '•••••••• (saved)' : 'Paste your API key'} />
            </div>
            <button
              onClick={handleSaveKey}
              disabled={!keyInput.trim()}
              className="px-3 py-1.5 rounded text-sm font-medium bg-orange-500 hover:bg-orange-400 text-white transition-colors disabled:opacity-40 disabled:hover:bg-orange-500"
            >
              Save key
            </button>
            {keyStatus !== 'none' && (
              <button
                onClick={() => { void saveAiKey(null); setTestResult(null); }}
                className="px-3 py-1.5 rounded text-sm font-medium border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
          <label className="flex items-center gap-2 mt-2 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="accent-orange-500" />
            Remember on this device
          </label>
          {!electron && remember && (
            <p className="text-[11px] text-orange-400/80 mt-1">In the browser the key is stored unencrypted in localStorage. Untick to keep it in memory only.</p>
          )}
          <p className={`text-xs mt-1.5 ${keyStatusText[keyStatus].tone}`}>{keyStatusText[keyStatus].text}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleTest}
            disabled={!s.enabled || validationError !== null || testing}
            className="px-3 py-1.5 rounded text-sm font-medium border border-orange-500 text-orange-400 hover:bg-orange-500/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && <span className={`text-xs ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>{testResult.text}</span>}
          {!testResult && lastError && lastError.code !== 'DISABLED' && inFlight.test === false && (
            <span className="text-xs text-red-400">{lastError.message}</span>
          )}
        </div>
        {validationError && <p className="text-xs text-red-400">{validationError}</p>}
      </Section>

      <Section title="Privacy">
        <Row label="Send response bodies">
          <Toggle checked={s.sendResponseBodies} onChange={v => update({ sendResponseBodies: v })} />
        </Row>
        <p className="text-[11px] text-slate-600 -mt-1">When off, only the structure (field names and types) of a response is sent, never its values.</p>
        <Row label="Mask credential-looking values">
          <Toggle checked={s.redactSecrets} onChange={v => update({ redactSecrets: v })} />
        </Row>
        <p className="text-[11px] text-slate-600 -mt-1">Values of variables marked secret are always masked, whatever this setting.</p>
        <div>
          <Label>Max context (tokens)</Label>
          <NumberInput value={s.maxContextTokens} onChange={v => update({ maxContextTokens: v })} min={500} max={200000} />
        </div>
        <div>
          <Label>Output language (optional)</Label>
          <TextInput value={s.outputLanguage ?? ''} onChange={v => update({ outputLanguage: v })} placeholder="e.g. English, Français" />
        </div>
        <button
          onClick={() => setShowPreview(true)}
          className="text-xs text-orange-400 hover:text-orange-300 underline underline-offset-2 transition-colors"
        >
          See what will be sent
        </button>
      </Section>

      <Section title="Features">
        {FEATURES.map(f => (
          <Row key={f.key} label={f.label}>
            <Toggle checked={s.features[f.key]} onChange={v => update({ features: { [f.key]: v } })} />
          </Row>
        ))}
        <p className="text-[11px] text-slate-600">Each switch takes effect as the matching feature becomes available.</p>
      </Section>

      <Section title="Exports">
        <Row label="Mark AI-written content in exports">
          <Toggle checked={s.markAiContent !== false} onChange={v => update({ markAiContent: v })} />
        </Row>
        <p className="text-[11px] text-slate-600 -mt-1">Default for documentation exports: adds an “AI-generated” badge or note to descriptions written by the model. You can still change it per export.</p>
      </Section>

      {showConsent && (
        <AiConsentModal
          destination={destination}
          onCancel={() => setShowConsent(false)}
          onAccept={() => { setShowConsent(false); update({ consentGiven: true, enabled: true }); }}
        />
      )}
      {showPreview && <AiPreviewDialog onClose={() => setShowPreview(false)} />}
    </div>
  );
}
