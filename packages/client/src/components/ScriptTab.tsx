import { useRef, useCallback } from 'react';
import ScriptEditor from './ScriptEditor';
import ScriptSnippetsLibrary from './ScriptSnippetsLibrary';

// ─── Shared ScriptTab component ───────────────────────────────────────────────

export interface ScriptTabProps {
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  target: 'prerequest' | 'test';
  requestNames?: string[];
  requestItems?: Array<{ id: string; name: string }>;
  onSyntaxCheck?: (hasError: boolean) => void;
  rows?: number;
  /** Extra Tailwind classes applied to the outer wrapper div. */
  className?: string;
}

export default function ScriptTab({
  label,
  value,
  onChange,
  placeholder,
  target,
  requestNames,
  requestItems,
  onSyntaxCheck,
  rows = 14,
  className = '',
}: ScriptTabProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInsert = useCallback((code: string) => {
    const el = textareaRef.current;
    if (!el) {
      onChange(value ? value + '\n\n' + code : code);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const separator = (value.length > 0 && !value.endsWith('\n')) ? '\n\n' : (value.length > 0 ? '\n' : '');
    const before = value.slice(0, start);
    const after = value.slice(end);
    const newValue = before + (start === end && start === value.length ? separator : '') + code + after;
    onChange(newValue);
    // Restore focus and move cursor after inserted snippet
    requestAnimationFrame(() => {
      const insertPos = start + (start === end && start === value.length ? separator.length : 0) + code.length;
      el.focus();
      el.setSelectionRange(insertPos, insertPos);
    });
  }, [value, onChange]);

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-slate-500 text-xs">{label}</p>
        <ScriptSnippetsLibrary target={target} onInsert={handleInsert} />
      </div>
      <ScriptEditor
        textareaRef={textareaRef}
        value={value}
        onChange={onChange}
        onSyntaxCheck={onSyntaxCheck}
        rows={rows}
        placeholder={placeholder}
        requestNames={requestNames}
        requestItems={requestItems}
      />
    </div>
  );
}
