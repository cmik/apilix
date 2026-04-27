import { useEffect } from 'react';

interface ConfirmModalProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true the confirm button uses red danger styling; false uses orange. Default: true */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Tailwind z-index class. Default: z-[60]  */
  zIndex?: string;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel,
  zIndex = 'z-[60]',
}: ConfirmModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className={`fixed inset-0 ${zIndex} flex items-center justify-center bg-black/60`}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[380px] p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        <div className="text-xs text-slate-400 leading-relaxed">{message}</div>
        <div className="flex flex-col gap-2 pt-1">
          <button
            autoFocus
            onClick={onConfirm}
            className={`w-full py-2 px-3 rounded text-xs font-medium transition-colors ${
              danger
                ? 'bg-red-700 hover:bg-red-600 text-white'
                : 'bg-orange-600 hover:bg-orange-500 text-white'
            }`}
          >
            {confirmLabel}
          </button>
          <button
            onClick={onCancel}
            className="w-full py-2 px-3 rounded text-xs font-medium border border-slate-700 hover:border-slate-600 text-slate-400 hover:text-slate-200 transition-colors"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
