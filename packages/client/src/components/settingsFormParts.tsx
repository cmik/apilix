import { useState, useEffect } from 'react';

// Shared form building blocks for the Settings modal and its tab components.

export function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-slate-400 mb-1">{children}</label>;
}

export function TextInput({
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

export function NumberInput({
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

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
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

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-slate-300">{label}</span>
      {children}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
