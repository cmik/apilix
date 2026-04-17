import { useRef, forwardRef, useState, useMemo, useEffect, useCallback } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markup';   // XML + HTML
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-javascript';
import './CodeEditor.css';
import {
  applyVariableSuggestion,
  filterVariableSuggestions,
  findVariableToken,
  previewVariableValue,
} from '../utils/variableAutocomplete';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CodeLanguage = 'json' | 'xml' | 'html' | 'graphql' | 'javascript' | 'text';

// Extend all standard textarea attributes — CodeEditor is a drop-in replacement
export interface CodeEditorProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> {
  value: string;
  language?: CodeLanguage;
  variableSuggestions?: VariableSuggestion[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

const CARET_MIRROR_PROPS = [
  'direction', 'boxSizing', 'width', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontSize', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing',
] as const;

function getCaretCoordinates(el: HTMLTextAreaElement, pos: number): { top: number; left: number } {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(el);
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    top: '0',
    left: '-9999px',
    width: `${el.offsetWidth}px`,
  });
  CARET_MIRROR_PROPS.forEach(prop => {
    (mirror.style as unknown as Record<string, string>)[prop] = computed[prop];
  });
  mirror.textContent = el.value.substring(0, pos);
  const caret = document.createElement('span');
  caret.textContent = '|';
  mirror.appendChild(caret);
  document.body.appendChild(mirror);
  const coords = { top: caret.offsetTop, left: caret.offsetLeft };
  document.body.removeChild(mirror);
  return coords;
}

interface VariableAutocompleteState {
  suggestions: VariableSuggestion[];
  selectedIndex: number;
  top: number;
  left: number;
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
 * Press Cmd+F / Ctrl+F to open the find bar; Cmd+H / Ctrl+H for find+replace.
 */
const CodeEditor = forwardRef<HTMLTextAreaElement, CodeEditorProps>(
  function CodeEditor({ value, language = 'text', className, onChange, onScroll, onKeyDown, onMouseUp, variableSuggestions, style, ...rest }, ref) {
    const preRef = useRef<HTMLDivElement>(null);
    // Internal ref so search/replace can call setSelectionRange
    const taRef = useRef<HTMLTextAreaElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Combine external forwarded ref with internal ref
    const setRef = useCallback(
      (el: HTMLTextAreaElement | null) => {
        (taRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      },
      [ref],
    );

    // ── Search / Replace state ──────────────────────────────────────────
    const [srOpen, setSrOpen] = useState(false);
    const [srMode, setSrMode] = useState<'find' | 'replace'>('find');
    const [srSearch, setSrSearch] = useState('');
    const [srReplace, setSrReplace] = useState('');
    const [matchIdx, setMatchIdx] = useState(0);
    const [variableAc, setVariableAc] = useState<VariableAutocompleteState | null>(null);

    // Focus search input when panel opens
    useEffect(() => {
      if (srOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
    }, [srOpen]);

    // All match positions [start, end] (case-insensitive)
    const matches = useMemo<[number, number][]>(() => {
      if (!srSearch) return [];
      const lower = value.toLowerCase();
      const needle = srSearch.toLowerCase();
      const positions: [number, number][] = [];
      let i = 0;
      while (i < value.length) {
        const found = lower.indexOf(needle, i);
        if (found === -1) break;
        positions.push([found, found + srSearch.length]);
        i = found + 1;
      }
      return positions;
    }, [srSearch, value]);

    // Clamp matchIdx whenever the matches list changes
    useEffect(() => {
      setMatchIdx(prev => (matches.length === 0 ? 0 : Math.min(prev, matches.length - 1)));
    }, [matches]);

    function callOnChange(newValue: string) {
      const handler = onChange;
      if (handler) handler({ target: { value: newValue } } as React.ChangeEvent<HTMLTextAreaElement>);
    }

    const updateVariableAutocomplete = useCallback((el: HTMLTextAreaElement, nextValue = el.value) => {
      if (!variableSuggestions || variableSuggestions.length === 0) {
        setVariableAc(null);
        return;
      }

      const cursorPosition = el.selectionStart ?? nextValue.length;
      const token = findVariableToken(nextValue, cursorPosition);
      if (!token) {
        setVariableAc(null);
        return;
      }

      const suggestions = filterVariableSuggestions(variableSuggestions, token.query);
      if (suggestions.length === 0) {
        setVariableAc(null);
        return;
      }

      const coords = getCaretCoordinates(el, token.openIndex);
      const lineHeight = parseInt(window.getComputedStyle(el).lineHeight, 10) || 24;
      setVariableAc({
        suggestions,
        selectedIndex: 0,
        top: coords.top + lineHeight - el.scrollTop + 2,
        left: Math.min(coords.left, Math.max(12, el.clientWidth - 320)),
      });
    }, [variableSuggestions]);

    function acceptVariableSuggestion(name: string) {
      const ta = taRef.current;
      if (!ta) return;
      const applied = applyVariableSuggestion(ta.value, ta.selectionStart, name);
      if (!applied) return;
      callOnChange(applied.value);
      setVariableAc(null);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(applied.cursor, applied.cursor);
      });
    }

    function gotoMatch(idx: number) {
      const ta = taRef.current;
      if (!ta || matches.length === 0) return;
      const clamped = ((idx % matches.length) + matches.length) % matches.length;
      setMatchIdx(clamped);
      const [start, end] = matches[clamped];
      ta.focus();
      ta.setSelectionRange(start, end);
      // Scroll into view: estimate line offset
      const lineHeight = 24; // matches EDITOR_STYLE lineHeight
      const lines = value.slice(0, start).split('\n').length - 1;
      ta.scrollTop = Math.max(0, lines * lineHeight - ta.clientHeight / 2);
    }

    function replaceCurrentMatch() {
      if (matches.length === 0) return;
      const clamped = ((matchIdx % matches.length) + matches.length) % matches.length;
      const [start, end] = matches[clamped];
      callOnChange(value.slice(0, start) + srReplace + value.slice(end));
    }

    function replaceAll() {
      if (!srSearch) return;
      try {
        callOnChange(value.replace(new RegExp(escapeRegex(srSearch), 'gi'), srReplace));
      } catch { /* noop */ }
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        if (srOpen && srMode === 'find') { setSrOpen(false); } else { setSrMode('find'); setSrOpen(true); }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
        e.preventDefault();
        if (srOpen && srMode === 'replace') { setSrOpen(false); } else { setSrMode('replace'); setSrOpen(true); }
      } else if (variableAc) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setVariableAc(state => state ? {
            ...state,
            selectedIndex: Math.min(state.selectedIndex + 1, state.suggestions.length - 1),
          } : state);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setVariableAc(state => state ? {
            ...state,
            selectedIndex: Math.max(state.selectedIndex - 1, 0),
          } : state);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          acceptVariableSuggestion(variableAc.suggestions[variableAc.selectedIndex].name);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setVariableAc(null);
          return;
        }
      }
      onKeyDown?.(e);
    }

    // Append '\n' so the pre never collapses a trailing newline in the value
    const highlighted = tokenize(value, language) + '\n';

    function handleScroll(e: React.UIEvent<HTMLTextAreaElement>) {
      if (preRef.current) {
        preRef.current.scrollTop  = e.currentTarget.scrollTop;
        preRef.current.scrollLeft = e.currentTarget.scrollLeft;
      }
      setVariableAc(null);
      onScroll?.(e);
    }

    useEffect(() => {
      if (!variableAc || !dropdownRef.current) return;
      const item = dropdownRef.current.querySelectorAll('[data-variable-suggestion]')[variableAc.selectedIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }, [variableAc]);

    useEffect(() => {
      if (!variableAc) return;
      function close() {
        setVariableAc(null);
      }
      function onPointerDown(event: PointerEvent) {
        if (
          dropdownRef.current?.contains(event.target as Node) ||
          taRef.current?.contains(event.target as Node)
        ) return;
        close();
      }
      document.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('scroll', close, true);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('scroll', close, true);
      };
    }, [variableAc]);

    const hasSearch = srOpen && srSearch.length > 0;
    const matchLabel = hasSearch
      ? matches.length === 0 ? 'No matches' : `${Math.min(matchIdx + 1, matches.length)}/${matches.length}`
      : '';

    // Rounded corners: flatten top when sr bar is open
    const editorRadius = srOpen ? '0 0 0.25rem 0.25rem' : '0.25rem';

    return (
      <div className={`flex flex-col w-full ${className ?? ''}`}>
        {/* ── Search / Replace toolbar ── */}
        {srOpen && (
          <div className="flex flex-col gap-1 bg-slate-800 border border-slate-600 border-b-0 rounded-t px-2 py-1.5">
            {/* Mode toggle tabs */}
            <div className="flex items-center gap-2 mb-0.5">
              <button onClick={() => setSrMode('find')} className={`text-[10px] px-2 py-0.5 rounded transition-colors ${srMode === 'find' ? 'text-orange-400 bg-slate-700' : 'text-slate-500 hover:text-slate-300'}`}>Find</button>
              <button onClick={() => setSrMode('replace')} className={`text-[10px] px-2 py-0.5 rounded transition-colors ${srMode === 'replace' ? 'text-orange-400 bg-slate-700' : 'text-slate-500 hover:text-slate-300'}`}>Replace</button>
            </div>
            {/* Row 1: search */}
            <div className="flex items-center gap-1.5">
              {/* Search icon */}
              <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={srSearch}
                onChange={e => { setSrSearch(e.target.value); setMatchIdx(0); }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? matchIdx - 1 : matchIdx + 1); }
                  if (e.key === 'Escape') { e.preventDefault(); setSrOpen(false); taRef.current?.focus(); }
                }}
                placeholder="Search…"
                spellCheck={false}
                className="flex-1 min-w-0 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500 placeholder:text-slate-500"
              />
              {/* Match count */}
              <span className={`text-[10px] shrink-0 w-14 text-right ${matches.length === 0 && hasSearch ? 'text-red-400' : 'text-orange-400'}`}>
                {matchLabel}
              </span>
              {/* Prev / Next */}
              <button
                onClick={() => gotoMatch(matchIdx - 1)}
                disabled={matches.length === 0}
                title="Previous match (Shift+Enter)"
                className="p-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <button
                onClick={() => gotoMatch(matchIdx + 1)}
                disabled={matches.length === 0}
                title="Next match (Enter)"
                className="p-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M9 18l6-6-6-6"/></svg>
              </button>
              {/* Close */}
              <button
                onClick={() => { setSrOpen(false); taRef.current?.focus(); }}
                title="Close (Escape)"
                className="p-0.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors ml-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            {/* Row 2: replace (only in replace mode) */}
            {srMode === 'replace' && <div className="flex items-center gap-1.5">
              {/* Replace icon (spacer to align with search icon) */}
              <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M4 4v5h5M20 20v-5h-5M4 9a9 9 0 0114.65-4.65M20 15a9 9 0 01-14.65 4.65"/>
              </svg>
              <input
                type="text"
                value={srReplace}
                onChange={e => setSrReplace(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setSrOpen(false); taRef.current?.focus(); } }}
                placeholder="Replace…"
                spellCheck={false}
                className="flex-1 min-w-0 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500 placeholder:text-slate-500"
              />
              <button
                onClick={replaceCurrentMatch}
                disabled={matches.length === 0}
                title="Replace current match"
                className="shrink-0 px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-xs text-slate-300 hover:text-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Replace
              </button>
              <button
                onClick={replaceAll}
                disabled={matches.length === 0}
                title="Replace all matches"
                className="shrink-0 px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-xs text-slate-300 hover:text-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                All
              </button>
            </div>}
          </div>
        )}

        {/* ── Editor area ── */}
        <div
          className="code-editor relative bg-slate-900 border border-slate-600 focus-within:border-orange-500 w-full"
          style={{ borderRadius: editorRadius }}
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
            ref={setRef}
            value={value}
            onChange={e => {
              onChange?.(e);
              updateVariableAutocomplete(e.currentTarget, e.currentTarget.value);
            }}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            onMouseUp={e => {
              updateVariableAutocomplete(e.currentTarget);
              onMouseUp?.(e);
            }}
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

          {variableAc && (
            <div
              ref={dropdownRef}
              className="absolute z-20 bg-slate-800 border border-slate-600 rounded shadow-2xl min-w-56 max-w-80 max-h-56 overflow-y-auto"
              style={{ top: variableAc.top, left: variableAc.left }}
            >
              {variableAc.suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.name}
                  type="button"
                  data-variable-suggestion
                  onMouseDown={event => {
                    event.preventDefault();
                    acceptVariableSuggestion(suggestion.name);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 ${
                    index === variableAc.selectedIndex
                      ? 'bg-orange-600/20 text-orange-300'
                      : 'text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <span className="text-slate-500">{'{{'}</span>
                  <span className="truncate">{suggestion.name}</span>
                  <span className="text-slate-500">{'}}'}</span>
                  {suggestion.value !== undefined && suggestion.value !== '' && (
                    <span className="ml-auto text-slate-500 truncate max-w-28">
                      {previewVariableValue(suggestion.value)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
);

export default CodeEditor;
