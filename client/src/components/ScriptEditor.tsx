import { useState, useRef, useCallback, useEffect } from 'react';

// ─── Completion model ─────────────────────────────────────────────────────────

interface Completion {
  label: string;   // displayed text
  insert: string;  // text to insert (replaces the typed prefix)
  detail: string;  // type annotation shown on right
}

// ─── Completion datasets ──────────────────────────────────────────────────────

const VAR_STORE: Completion[] = [
  { label: 'get(key)',          insert: "get('",         detail: 'string'  },
  { label: 'set(key, value)',   insert: "set('",         detail: 'void'    },
  { label: 'unset(key)',        insert: "unset('",       detail: 'void'    },
  { label: 'has(key)',          insert: "has('",         detail: 'boolean' },
  { label: 'clear()',           insert: 'clear()',       detail: 'void'    },
];

const RESPONSE_HEADERS: Completion[] = [
  { label: 'get(name)', insert: "get('", detail: 'string | undefined' },
];

const REQUEST_HEADERS: Completion[] = [
  { label: 'upsert({ key, value })', insert: 'upsert({ key: ', detail: 'void' },
];

const RESPONSE: Completion[] = [
  { label: 'code',         insert: 'code',         detail: 'number' },
  { label: 'status',       insert: 'status',       detail: 'string' },
  { label: 'responseTime', insert: 'responseTime', detail: 'number' },
  { label: 'json()',       insert: 'json()',        detail: 'any'    },
  { label: 'text()',       insert: 'text()',        detail: 'string' },
  { label: 'headers',      insert: 'headers',      detail: 'object' },
  { label: 'size',         insert: 'size',         detail: 'number' },
];

const REQUEST: Completion[] = [
  { label: 'headers', insert: 'headers', detail: 'object' },
  { label: 'url',     insert: 'url',     detail: 'string' },
  { label: 'method',  insert: 'method',  detail: 'string' },
];

const EXECUTION: Completion[] = [
  { label: 'skipRequest()',          insert: 'skipRequest()',   detail: 'void' },
  { label: 'setNextRequest(name)',   insert: "setNextRequest('", detail: 'void' },
];

const ITERATION_DATA: Completion[] = [
  { label: 'get(key)', insert: "get('", detail: 'string'  },
  { label: 'has(key)', insert: "has('", detail: 'boolean' },
];

const INFO: Completion[] = [
  { label: 'requestId', insert: 'requestId', detail: 'string' },
  { label: 'iteration',  insert: 'iteration',  detail: 'number' },
  { label: 'eventName',  insert: 'eventName',  detail: 'string' },
];

// ─── Mock-script completions ──────────────────────────────────────────────────

const MOCK_REQ_HEADERS: Completion[] = [
  { label: "['header-name']", insert: "['",            detail: 'string | undefined' },
];

const MOCK_REQ_QUERY: Completion[] = [
  { label: "['param']",       insert: "['",            detail: 'string | undefined' },
];

const MOCK_REQ_PARAMS: Completion[] = [
  { label: "['param']",       insert: "['",            detail: 'string | undefined' },
];

const MOCK_REQ_BODY: Completion[] = [
  { label: "['field']",       insert: "['",            detail: 'any' },
];

const MOCK_REQ: Completion[] = [
  { label: 'method',        insert: 'method',        detail: 'string'  },
  { label: 'path',          insert: 'path',          detail: 'string'  },
  { label: 'url',           insert: 'url',           detail: 'string'  },
  { label: 'headers',       insert: 'headers',       detail: 'object'  },
  { label: 'query',         insert: 'query',         detail: 'object'  },
  { label: 'params',        insert: 'params',        detail: 'object'  },
  { label: 'body',          insert: 'body',          detail: 'object'  },
  { label: 'requestCount',  insert: 'requestCount',  detail: 'number'  },
];

const MOCK_ROOT: Completion[] = [
  { label: 'req',               insert: 'req',               detail: 'object' },
  { label: 'respond(status, body)', insert: 'respond(',       detail: 'void'   },
  { label: 'JSON.stringify()',  insert: 'JSON.stringify(',   detail: 'string' },
  { label: 'JSON.parse()',      insert: 'JSON.parse(',       detail: 'any'    },
  { label: 'Math.random()',     insert: 'Math.random()',     detail: 'number' },
  { label: 'Math.floor()',      insert: 'Math.floor(',       detail: 'number' },
  { label: 'Date.now()',        insert: 'Date.now()',        detail: 'number' },
  { label: 'new Date()',        insert: 'new Date()',        detail: 'Date'   },
];

function getMockContext(textBefore: string): { completions: Completion[]; prefix: string } | null {
  let m: RegExpMatchArray | null;

  m = textBefore.match(/\breq\.headers\.?(\w*)$/);
  if (m) return { completions: MOCK_REQ_HEADERS, prefix: '' };

  m = textBefore.match(/\breq\.query\.?(\w*)$/);
  if (m) return { completions: MOCK_REQ_QUERY, prefix: '' };

  m = textBefore.match(/\breq\.params\.?(\w*)$/);
  if (m) return { completions: MOCK_REQ_PARAMS, prefix: '' };

  m = textBefore.match(/\breq\.body\.?(\w*)$/);
  if (m) return { completions: MOCK_REQ_BODY, prefix: '' };

  m = textBefore.match(/\breq\.(\w*)$/);
  if (m) return { completions: MOCK_REQ, prefix: m[1] };

  m = textBefore.match(/(?:^|[\s;{}(,!&|?:])(\w*)$/);
  if (m) {
    const prefix = m[1];
    const filtered = MOCK_ROOT.filter(c => prefix.length > 0 && c.label.startsWith(prefix));
    if (filtered.length > 0) return { completions: filtered, prefix };
  }

  return null;
}

const ROOT: Completion[] = [
  { label: 'environment',          insert: 'environment',          detail: 'object'     },
  { label: 'globals',              insert: 'globals',              detail: 'object'     },
  { label: 'collection',           insert: 'collection',           detail: 'object'     },
  { label: 'collectionVariables',  insert: 'collectionVariables',  detail: 'object (alias)' },
  { label: 'variables',            insert: 'variables',            detail: 'object'     },
  { label: 'request',              insert: 'request',              detail: 'object'     },
  { label: 'response',             insert: 'response',             detail: 'object'     },
  { label: 'iterationData',        insert: 'iterationData',        detail: 'object'     },
  { label: 'execution',            insert: 'execution',            detail: 'object'     },
  { label: 'info',                 insert: 'info',                 detail: 'object'     },
  { label: 'test(name, fn)',        insert: 'test(',                detail: 'void'       },
  { label: 'expect(value)',         insert: 'expect(',              detail: 'Assertion'  },
  { label: 'sendRequest(opts, cb)', insert: 'sendRequest(',         detail: 'void'       },
  { label: 'executeRequest(name)',  insert: "executeRequest('",      detail: 'Promise<void>' },
];

// ─── Context detection ────────────────────────────────────────────────────────

function getContext(textBefore: string, requestNames: string[]): { completions: Completion[]; prefix: string } | null {
  let m: RegExpMatchArray | null;

  // Most specific patterns first
  m = textBefore.match(/(?:apx|pm)\.response\.headers\.(\w*)$/);
  if (m) return { completions: RESPONSE_HEADERS, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.request\.headers\.(\w*)$/);
  if (m) return { completions: REQUEST_HEADERS, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.response\.(\w*)$/);
  if (m) return { completions: RESPONSE, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.request\.(\w*)$/);
  if (m) return { completions: REQUEST, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.(?:environment|globals|collection|collectionVariables|variables)\.(\w*)$/);
  if (m) return { completions: VAR_STORE, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.iterationData\.(\w*)$/);
  if (m) return { completions: ITERATION_DATA, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.execution\.(\w*)$/);
  if (m) return { completions: EXECUTION, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.info\.(\w*)$/);
  if (m) return { completions: INFO, prefix: m[1] };

  // Request-name autocomplete inside apx.executeRequest('...
  m = textBefore.match(/(?:apx|pm)\.executeRequest\(['"]([^'"]*)$/);
  if (m) {
    const prefix = m[1];
    const completions = requestNames
      .filter(n => n.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(n => ({ label: n, insert: n, detail: 'request' }));
    if (completions.length > 0) return { completions, prefix };
  }

  // Request-name autocomplete inside pm.execution.setNextRequest('...
  m = textBefore.match(/(?:apx|pm)\.execution\.setNextRequest\(['"]([^'"]*)$/);
  if (m) {
    const prefix = m[1];
    const completions = requestNames
      .filter(n => n.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(n => ({ label: n, insert: n, detail: 'request' }));
    if (completions.length > 0) return { completions, prefix };
  }

  // Root: trigger on "apx." or "pm." (empty prefix, or partial word prefix)
  m = textBefore.match(/(?:apx|pm)\.(\w*)$/);
  if (m) return { completions: ROOT, prefix: m[1] };

  return null;
}

// ─── Caret pixel coordinates (mirror-div technique) ──────────────────────────

const MIRROR_PROPS = [
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
    width: el.offsetWidth + 'px',
  });
  MIRROR_PROPS.forEach(p => { (mirror.style as unknown as Record<string, string>)[p] = computed[p]; });
  mirror.textContent = el.value.substring(0, pos);
  const caret = document.createElement('span');
  caret.textContent = '|';
  mirror.appendChild(caret);
  document.body.appendChild(mirror);
  const coords = { top: caret.offsetTop, left: caret.offsetLeft };
  document.body.removeChild(mirror);
  return coords;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface AcState {
  completions: Completion[];
  replaceStart: number;
  selectedIdx: number;
  top: number;
  left: number;
}

export interface ScriptEditorProps {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  /** Forward an external ref so the parent can read selectionStart/End for snippet insertion */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  className?: string;
  /** Request names from the current collection, for apx.executeRequest() autocomplete */
  requestNames?: string[];
  /** 'mock' uses the req/respond context; default uses the apx/pm context */
  variant?: 'default' | 'mock';
}

export default function ScriptEditor({
  value,
  onChange,
  rows = 14,
  placeholder,
  textareaRef,
  className,
  requestNames,
  variant = 'default',
}: ScriptEditorProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const ref = (textareaRef as React.RefObject<HTMLTextAreaElement>) ?? internalRef;

  const [ac, setAc] = useState<AcState | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const recompute = useCallback((el: HTMLTextAreaElement) => {
    const pos = el.selectionStart;
    const textBefore = el.value.substring(0, pos);
    const ctx = variant === 'mock'
      ? getMockContext(textBefore)
      : getContext(textBefore, requestNames ?? []);
    if (!ctx) { setAc(null); return; }

    const filtered = ctx.completions.filter(c =>
      c.label.toLowerCase().startsWith(ctx.prefix.toLowerCase()),
    );
    if (filtered.length === 0) { setAc(null); return; }

    const replaceStart = pos - ctx.prefix.length;
    const caretCoords = getCaretCoordinates(el, replaceStart);
    const rect = el.getBoundingClientRect();
    const lineH = parseInt(window.getComputedStyle(el).lineHeight, 10) || 18;
    const rawTop = rect.top + caretCoords.top + lineH - el.scrollTop + 2;
    const rawLeft = rect.left + caretCoords.left;

    setAc({
      completions: filtered,
      replaceStart,
      selectedIdx: 0,
      // Keep dropdown within viewport horizontally
      top: rawTop,
      left: Math.min(rawLeft, window.innerWidth - 310),
    });
  }, [requestNames]);

  function accept(comp: Completion) {
    const el = ref.current;
    if (!el || !ac) return;
    const cursor = el.selectionStart;
    const newValue = value.substring(0, ac.replaceStart) + comp.insert + value.substring(cursor);
    onChange(newValue);
    setAc(null);
    requestAnimationFrame(() => {
      el.focus();
      const p = ac.replaceStart + comp.insert.length;
      el.setSelectionRange(p, p);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!ac) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAc(s => s ? { ...s, selectedIdx: Math.min(s.selectedIdx + 1, s.completions.length - 1) } : s);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAc(s => s ? { ...s, selectedIdx: Math.max(s.selectedIdx - 1, 0) } : s);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(ac.completions[ac.selectedIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setAc(null);
    }
  }

  // Close on outside pointer down or any scroll
  useEffect(() => {
    if (!ac) return;
    function close() { setAc(null); }
    function onPointerDown(e: PointerEvent) {
      if (
        dropdownRef.current?.contains(e.target as Node) ||
        ref.current?.contains(e.target as Node)
      ) return;
      close();
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [ac, ref]);

  // Scroll selected item into view
  useEffect(() => {
    if (!ac || !dropdownRef.current) return;
    const el = dropdownRef.current.children[ac.selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [ac?.selectedIdx]);

  const textareaClass =
    className ??
    'w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y';

  return (
    <>
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onInput={e => recompute(e.currentTarget)}
        onKeyDown={handleKeyDown}
        onClick={e => recompute(e.currentTarget)}
        rows={rows}
        spellCheck={false}
        className={textareaClass}
        placeholder={placeholder}
      />

      {ac && (
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: ac.top,
            left: ac.left,
            zIndex: 9999,
            maxHeight: '220px',
            minWidth: '280px',
            maxWidth: '420px',
          }}
          className="bg-slate-800 border border-slate-600 rounded shadow-2xl overflow-y-auto"
        >
          {/* Hint row */}
          <div className="flex items-center justify-between px-3 py-1 border-b border-slate-700">
            <span className="text-xs text-slate-500 select-none">
              ↑↓ navigate &nbsp;·&nbsp; ↵ / Tab accept &nbsp;·&nbsp; Esc dismiss
            </span>
          </div>

          {ac.completions.map((comp, i) => (
            <div
              key={comp.label}
              onMouseDown={e => { e.preventDefault(); accept(comp); }}
              className={`flex items-center justify-between px-3 py-1.5 cursor-pointer select-none ${
                i === ac.selectedIdx
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-200 hover:bg-slate-700'
              }`}
            >
              <span className="text-xs font-mono font-medium">{comp.label}</span>
              <span className={`text-xs font-mono ml-4 shrink-0 ${i === ac.selectedIdx ? 'text-orange-200' : 'text-slate-500'}`}>
                {comp.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
