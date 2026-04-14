import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  /** Duration in ms; 0 = persist until dismissed. Default 4000. */
  duration?: number;
}

interface ToastContextValue {
  addToast: (type: ToastType, message: string, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let idCounter = 0;
function nextId() {
  return `toast-${++idCounter}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, message: string, duration = 4000) => {
    const id = nextId();
    setToasts(prev => [...prev, { id, type, message, duration }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
  }, []);

  const success = useCallback((m: string, d?: number) => addToast('success', m, d), [addToast]);
  const error   = useCallback((m: string, d?: number) => addToast('error',   m, d), [addToast]);
  const warning = useCallback((m: string, d?: number) => addToast('warning', m, d), [addToast]);
  const info    = useCallback((m: string, d?: number) => addToast('info',    m, d), [addToast]);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, success, error, warning, info }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

// ── Individual toast item ────────────────────────────────────────────────────

const STYLES: Record<ToastType, { bar: string; icon: string; label: string }> = {
  success: { bar: 'bg-green-500',  icon: '✓', label: 'bg-green-500/15 border-green-600/40 text-green-300' },
  error:   { bar: 'bg-red-500',    icon: '✕', label: 'bg-red-500/15   border-red-600/40   text-red-300'   },
  warning: { bar: 'bg-amber-500',  icon: '!', label: 'bg-amber-500/15 border-amber-600/40 text-amber-300' },
  info:    { bar: 'bg-blue-500',   icon: 'i', label: 'bg-blue-500/15  border-blue-600/40  text-blue-300'  },
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Slide in
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Progress bar
  const [progress, setProgress] = useState(100);
  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;
    const start = Date.now();
    const tick = () => {
      const elapsed = Date.now() - start;
      setProgress(Math.max(0, 100 - (elapsed / toast.duration!) * 100));
      if (elapsed < toast.duration!) {
        timerRef.current = setTimeout(tick, 50);
      }
    };
    timerRef.current = setTimeout(tick, 50);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [toast.duration]);

  const s = STYLES[toast.type];

  return (
    <div
      className={`relative overflow-hidden rounded-md border shadow-xl w-80 transition-all duration-300 ${s.label} ${
        visible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'
      }`}
      role={toast.type === 'error' ? 'alert' : 'status'}
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      {/* Progress bar */}
      {toast.duration && toast.duration > 0 && (
        <div
          className={`absolute bottom-0 left-0 h-0.5 ${s.bar} transition-all duration-75`}
          style={{ width: `${progress}%` }}
        />
      )}

      <div className="flex items-start gap-2.5 px-3 py-2.5 pr-8">
        {/* Icon */}
        <span className={`shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-xs font-bold ${s.bar} text-white`}>
          {s.icon}
        </span>

        {/* Message — support multi-line (newline separated) */}
        <p className="text-xs leading-relaxed whitespace-pre-wrap break-words flex-1 min-w-0">
          {toast.message}
        </p>
      </div>

      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(toast.id)}
        className="absolute top-1.5 right-1.5 text-current opacity-50 hover:opacity-90 text-sm leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

// ── Container ────────────────────────────────────────────────────────────────

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 right-4 z-[9999] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}
