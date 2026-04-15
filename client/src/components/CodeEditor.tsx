import { useRef, forwardRef } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markup';   // XML + HTML
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-javascript';
import './CodeEditor.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CodeLanguage = 'json' | 'xml' | 'html' | 'graphql' | 'javascript' | 'text';

// Extend all standard textarea attributes — CodeEditor is a drop-in replacement
export interface CodeEditorProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> {
  value: string;
  language?: CodeLanguage;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getGrammar(lang: CodeLanguage): Prism.Grammar | null {
  switch (lang) {
    case 'json':       return Prism.languages.json;
    case 'xml':
    case 'html':       return Prism.languages.markup;
    case 'graphql':    return Prism.languages.graphql;
    case 'javascript': return Prism.languages.javascript;
    default:           return null;
  }
}

function tokenize(value: string, language: CodeLanguage): string {
  const grammar = getGrammar(language);
  if (!grammar) return escapeHtml(value);
  return Prism.highlight(value, grammar, language);
}

// Shared text-layout styles applied to both the pre overlay and textarea so
// their rendered content is pixel-aligned. Any change here must be consistent.
const EDITOR_STYLE: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
  fontSize: '0.875rem',     // text-sm
  lineHeight: '1.5rem',
  padding: '8px 12px',
  tabSize: 2,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  overflowWrap: 'break-word',
  boxSizing: 'border-box',
  margin: 0,
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Drop-in `<textarea>` replacement that adds syntax highlighting.
 * Accepts all standard textarea props (ref, onChange, onKeyDown, onScroll, …).
 */
const CodeEditor = forwardRef<HTMLTextAreaElement, CodeEditorProps>(
  function CodeEditor({ value, language = 'text', className, onScroll, style, ...rest }, ref) {
    const preRef = useRef<HTMLDivElement>(null);

    // Append '\n' so the pre never collapses a trailing newline in the value
    const highlighted = tokenize(value, language) + '\n';

    function handleScroll(e: React.UIEvent<HTMLTextAreaElement>) {
      if (preRef.current) {
        preRef.current.scrollTop  = e.currentTarget.scrollTop;
        preRef.current.scrollLeft = e.currentTarget.scrollLeft;
      }
      onScroll?.(e);
    }

    return (
      <div
        className={`code-editor relative bg-slate-900 border border-slate-600 rounded focus-within:border-orange-500 w-full ${className ?? ''}`}
      >
        {/* Read-only highlighted overlay — sits behind the textarea */}
        <div
          ref={preRef}
          aria-hidden="true"
          className="code-highlight absolute inset-0 z-0 pointer-events-none overflow-hidden select-none text-slate-100"
          style={EDITOR_STYLE}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />

        {/* Editable textarea — transparent text lets the overlay show through */}
        <textarea
          ref={ref}
          value={value}
          onScroll={handleScroll}
          spellCheck={false}
          {...rest}
          style={{
            ...EDITOR_STYLE,
            ...style,
            background: 'transparent',
            color: 'transparent',
            caretColor: '#e2e8f0',   // slate-200 caret
          }}
          className="relative z-10 w-full resize-y focus:outline-none bg-transparent selection:bg-sky-500/30"
        />
      </div>
    );
  }
);

export default CodeEditor;
