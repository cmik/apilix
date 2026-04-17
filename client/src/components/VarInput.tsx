import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  findVariableToken,
  filterVariableSuggestions,
  applyVariableSuggestion,
  previewVariableValue,
} from '../utils/variableAutocomplete';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

// ─── Types ────────────────────────────────────────────────────────────────────

interface VarInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  variableSuggestions?: VariableSuggestion[];
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for <input> that adds {{ }} variable autocomplete.
 * Matches the CodeEditor dropdown style. When variableSuggestions is empty
 * or absent, it behaves exactly like a plain <input>.
 */
export default function VarInput({
  value,
  onChange,
  variableSuggestions,
  onKeyDown,
  onBlur,
  className,
  ...rest
}: VarInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [acSuggestions, setAcSuggestions] = useState<VariableSuggestion[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const updateAc = useCallback(
    (val: string, cursor: number) => {
      if (!variableSuggestions || variableSuggestions.length === 0) {
        setAcSuggestions([]);
        setDropdownPos(null);
        return;
      }
      const token = findVariableToken(val, cursor);
      if (!token) {
        setAcSuggestions([]);
        setDropdownPos(null);
        return;
      }
      const filtered = filterVariableSuggestions(variableSuggestions, token.query);
      setAcSuggestions(filtered);
      setAcIndex(0);
      if (filtered.length > 0 && inputRef.current) {
        const rect = inputRef.current.getBoundingClientRect();
        setDropdownPos({ top: rect.bottom + window.scrollY, left: rect.left + window.scrollX, width: rect.width });
      }
    },
    [variableSuggestions],
  );

  function accept(name: string) {
    const inp = inputRef.current;
    if (!inp) return;
    const applied = applyVariableSuggestion(inp.value, inp.selectionStart ?? inp.value.length, name);
    if (!applied) return;
    onChange(applied.value);
    setAcSuggestions([]);
    setDropdownPos(null);
    requestAnimationFrame(() => {
      inp.focus();
      inp.setSelectionRange(applied.cursor, applied.cursor);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (acSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex(i => (i + 1) % acSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex(i => (i - 1 + acSuggestions.length) % acSuggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(acSuggestions[acIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAcSuggestions([]);
        setDropdownPos(null);
        return;
      }
    }
    onKeyDown?.(e);
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    // Delay so onMouseDown on a suggestion fires before the list closes.
    setTimeout(() => { setAcSuggestions([]); setDropdownPos(null); }, 150);
    onBlur?.(e);
  }

  return (
    <div className="relative flex-1 min-w-0">
      <input
        ref={inputRef}
        value={value}
        onChange={e => {
          onChange(e.target.value);
          updateAc(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={className}
        {...rest}
      />
      {acSuggestions.length > 0 && dropdownPos && createPortal(
        <div
          style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, minWidth: Math.max(dropdownPos.width, 208), zIndex: 9999 }}
          className="bg-slate-800 border border-slate-600 rounded shadow-xl max-h-52 overflow-y-auto"
        >
          {acSuggestions.map((s, i) => (
            <button
              key={s.name}
              type="button"
              data-variable-suggestion
              onMouseDown={e => { e.preventDefault(); accept(s.name); }}
              className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 ${
                i === acIndex ? 'bg-orange-600/20 text-orange-300' : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              <span className="text-slate-500">{'{{'}</span>
              <span className="truncate">{s.name}</span>
              <span className="text-slate-500">{'}}'}</span>
              {s.value !== undefined && s.value !== '' && (
                <span className="ml-auto text-slate-500 truncate max-w-28">{previewVariableValue(s.value)}</span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
