import { useEffect } from 'react';
import { IconSparkle } from './Icons';

interface Props {
  /** Where requests will go, e.g. "Anthropic" or "http://localhost:11434/v1". */
  destination: string;
  onAccept: () => void;
  onCancel: () => void;
}

/** First-use disclosure: shown once, before AI features can be enabled. */
export default function AiConsentModal({ destination, onAccept, onCancel }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[460px] max-w-[92vw] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <IconSparkle className="w-4 h-4 text-orange-400" />
          <h3 className="text-sm font-semibold text-slate-200">Before you enable AI features</h3>
        </div>
        <div className="text-xs text-slate-400 leading-relaxed space-y-2">
          <p>
            When you use an AI feature, Apilix sends the relevant request and response details to{' '}
            <span className="text-slate-200 font-medium">{destination}</span>.
          </p>
          <ul className="list-disc pl-4 space-y-1">
            <li>Sent: method, URL, headers, body, scripts, response status/headers/body and variable <em>names</em>.</li>
            <li>Masked first: values of variables marked secret are never sent, and credential-looking values (tokens, passwords, cookies, API keys) are replaced by <code className="text-slate-300">&lt;redacted&gt;</code>.</li>
            <li>Nothing is sent until you use an AI feature. You can review the exact payload with “See what will be sent”.</li>
            <li>Apilix keeps a local usage log (feature, model, token counts) without any prompt or reply content.</li>
          </ul>
          <p>You can disable AI features at any time in Settings → AI.</p>
        </div>
        <div className="flex flex-col gap-2 pt-1">
          <button
            onClick={onAccept}
            className="w-full py-2 rounded text-sm font-medium bg-orange-500 hover:bg-orange-400 text-white transition-colors"
          >
            I understand, enable AI features
          </button>
          <button
            onClick={onCancel}
            className="w-full py-2 rounded text-sm font-medium border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
