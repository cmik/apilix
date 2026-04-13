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
  { label: 'toObject()',        insert: 'toObject()',    detail: 'object'  },
];

const RESPONSE_HEADERS: Completion[] = [
  { label: 'get(name)', insert: "get('", detail: 'string | undefined' },
  { label: 'has(name)', insert: "has('", detail: 'boolean' },
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
  { label: 'to',           insert: 'to',           detail: 'assertion helper' },
];

const RESPONSE_TO: Completion[] = [
  { label: 'have', insert: 'have', detail: 'helper chain' },
  { label: 'be',   insert: 'be',   detail: 'helper chain' },
];

const RESPONSE_TO_HAVE: Completion[] = [
  { label: 'status(code)',          insert: 'status(',      detail: 'assert status code' },
  { label: 'header(name, value?)',  insert: "header('",    detail: 'assert header' },
  { label: 'body(text)',            insert: 'body(',        detail: 'assert body contains text' },
  { label: 'jsonBody()',            insert: 'jsonBody()',   detail: 'assert valid JSON body' },
];

const RESPONSE_TO_BE: Completion[] = [
  { label: 'ok()', insert: 'ok()', detail: 'assert 2xx response' },
];

const REQUEST: Completion[] = [
  { label: 'headers', insert: 'headers', detail: 'object' },
  { label: 'url',     insert: 'url',     detail: 'string' },
  { label: 'method',  insert: 'method',  detail: 'string' },
];

const EXECUTION: Completion[] = [
  { label: 'skipRequest()',           insert: 'skipRequest()',    detail: 'void' },
  { label: 'setNextRequest(name)',    insert: "setNextRequest('",  detail: 'void' },
  { label: 'setNextRequestById(id)',  insert: "setNextRequestById('", detail: 'void' },
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

const TEST_FN: Completion[] = [
  { label: 'skip(name)', insert: 'skip(', detail: 'record skipped test' },
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

const MOCK_DB: Completion[] = [
  { label: 'get(key, fallback)',        insert: "get('",         detail: 'any' },
  { label: 'set(key, value)',           insert: "set('",         detail: 'any' },
  { label: 'has(key)',                  insert: "has('",         detail: 'boolean' },
  { label: 'delete(key)',               insert: "delete('",      detail: 'boolean' },
  { label: 'clear()',                   insert: 'clear()',       detail: 'void' },
  { label: 'keys()',                    insert: 'keys()',        detail: 'string[]' },
  { label: 'list(key)',                 insert: "list('",        detail: 'any[]' },
  { label: 'push(key, value)',          insert: "push('",        detail: 'any' },
  { label: 'findById(key, id)',         insert: "findById('",    detail: 'any | null' },
  { label: 'upsertById(key, id, patch)', insert: "upsertById('", detail: 'any' },
  { label: 'removeById(key, id)',       insert: "removeById('",  detail: 'boolean' },
];

const MOCK_ROOT: Completion[] = [
  { label: 'req',               insert: 'req',               detail: 'object' },
  { label: 'db',                insert: 'db',                detail: 'object' },
  { label: 'respond(status, body)', insert: 'respond(',       detail: 'void'   },
  { label: 'JSON.stringify()',  insert: 'JSON.stringify(',   detail: 'string' },
  { label: 'JSON.parse()',      insert: 'JSON.parse(',       detail: 'any'    },
  { label: 'Math.random()',     insert: 'Math.random()',     detail: 'number' },
  { label: 'Math.floor()',      insert: 'Math.floor(',       detail: 'number' },
  { label: 'Date.now()',        insert: 'Date.now()',        detail: 'number' },
  { label: 'new Date()',        insert: 'new Date()',        detail: 'Date'   },
];

function normalizeCompletionText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

function compactCompletionText(text: string): string {
  return text.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function getCompletionScore(completion: Completion, query: string): number | null {
  if (!query) return 0;

  const normalizedQuery = normalizeCompletionText(query);
  const compactQuery = compactCompletionText(query);
  if (!normalizedQuery) return 0;

  const normalizedLabel = normalizeCompletionText(completion.label);
  const normalizedInsert = normalizeCompletionText(completion.insert);
  const compactLabel = compactCompletionText(completion.label);
  const compactInsert = compactCompletionText(completion.insert);
  const words = Array.from(new Set(
    `${normalizedLabel} ${normalizedInsert} ${normalizeCompletionText(completion.detail)}`
      .split(/\s+/)
      .filter(Boolean),
  ));

  if (normalizedLabel.startsWith(normalizedQuery) || normalizedInsert.startsWith(normalizedQuery)) {
    return 0;
  }

  if (compactQuery && (compactLabel.startsWith(compactQuery) || compactInsert.startsWith(compactQuery))) {
    return 5;
  }

  const exactWordIndex = words.findIndex(word => word === normalizedQuery);
  if (exactWordIndex !== -1) return 10 + exactWordIndex;

  const wordPrefixIndex = words.findIndex(word => word.startsWith(normalizedQuery));
  if (wordPrefixIndex !== -1) return 20 + wordPrefixIndex;

  const labelIndex = normalizedLabel.indexOf(normalizedQuery);
  if (labelIndex !== -1) return 30 + labelIndex / 1000;

  const insertIndex = normalizedInsert.indexOf(normalizedQuery);
  if (insertIndex !== -1) return 40 + insertIndex / 1000;

  const compactLabelIndex = compactQuery ? compactLabel.indexOf(compactQuery) : -1;
  if (compactLabelIndex !== -1) return 50 + compactLabelIndex / 1000;

  const compactInsertIndex = compactQuery ? compactInsert.indexOf(compactQuery) : -1;
  if (compactInsertIndex !== -1) return 60 + compactInsertIndex / 1000;

  return null;
}

function getMockContext(textBefore: string): { completions: Completion[]; prefix: string } | null {
  let m: RegExpMatchArray | null;

  m = textBefore.match(/\bdb\.(\w*)$/);
  if (m) return { completions: MOCK_DB, prefix: m[1] };

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

const EXPECT_CHAIN: Completion[] = [
  // Getters
  { label: 'ok',         insert: 'ok',         detail: 'truthy'   },
  { label: 'true',       insert: 'true',       detail: 'boolean'  },
  { label: 'false',      insert: 'false',      detail: 'boolean'  },
  { label: 'null',       insert: 'null',       detail: 'null'     },
  { label: 'undefined',  insert: 'undefined',  detail: 'undefined'},
  { label: 'NaN',        insert: 'NaN',        detail: 'not a number' },
  { label: 'exist',      insert: 'exist',      detail: '!= null'  },
  { label: 'empty',      insert: 'empty',      detail: 'empty'    },
  { label: 'positive',   insert: 'positive',   detail: 'number > 0' },
  { label: 'negative',   insert: 'negative',   detail: 'number < 0' },
  { label: 'integer',    insert: 'integer',    detail: 'integer'  },
  { label: 'finite',     insert: 'finite',     detail: 'finite'   },
  // Methods
  { label: 'equal(value)',           insert: 'equal(',           detail: 'strict equality' },
  { label: 'equals(value)',          insert: 'equals(',          detail: 'alias of equal' },
  { label: 'eq(value)',              insert: 'eq(',              detail: 'alias of equal' },
  { label: 'eql(value)',             insert: 'eql(',             detail: 'deep equal'     },
  { label: 'eqls(value)',            insert: 'eqls(',            detail: 'alias of eql'   },
  { label: 'include(value)',         insert: 'include(',         detail: 'contains value' },
  { label: 'includes(value)',        insert: 'includes(',        detail: 'alias of include' },
  { label: 'contain(value)',         insert: 'contain(',         detail: 'alias of include' },
  { label: 'contains(value)',        insert: 'contains(',        detail: 'alias of include' },
  { label: 'members(array)',         insert: 'members([',        detail: 'exact set'      },
  { label: 'includeMembers(array)',  insert: 'includeMembers([', detail: 'superset'       },
  { label: 'oneOf(array)',           insert: 'oneOf([',          detail: 'one of values'  },
  { label: 'everyItem(fn)',          insert: 'everyItem(',       detail: 'all items pass' },
  { label: 'someItem(fn)',           insert: 'someItem(',        detail: 'some item passes' },
  { label: 'subset(object)',         insert: 'subset({',         detail: 'partial match'  },
  { label: 'deepProperty(path, value?)', insert: "deepProperty('", detail: 'dot path lookup' },
  { label: 'satisfy(fn)',            insert: 'satisfy(',         detail: 'custom predicate' },
  { label: 'satisfies(fn)',          insert: 'satisfies(',       detail: 'alias of satisfy' },
  { label: 'matchSchema(schema)',    insert: 'matchSchema({',    detail: 'JSON Schema validation' },
  { label: 'startWith(text)',        insert: "startWith('",      detail: 'string prefix'  },
  { label: 'endWith(text)',          insert: "endWith('",        detail: 'string suffix'  },
  { label: 'above(number)',          insert: 'above(',           detail: 'greater than'   },
  { label: 'gt(number)',             insert: 'gt(',              detail: 'alias of above' },
  { label: 'greaterThan(number)',    insert: 'greaterThan(',     detail: 'alias of above' },
  { label: 'below(number)',          insert: 'below(',           detail: 'less than'      },
  { label: 'lt(number)',             insert: 'lt(',              detail: 'alias of below' },
  { label: 'lessThan(number)',       insert: 'lessThan(',        detail: 'alias of below' },
  { label: 'least(number)',          insert: 'least(',           detail: 'at least'       },
  { label: 'gte(number)',            insert: 'gte(',             detail: 'alias of least' },
  { label: 'most(number)',           insert: 'most(',            detail: 'at most'        },
  { label: 'lte(number)',            insert: 'lte(',             detail: 'alias of most'  },
  { label: 'within(min, max)',       insert: 'within(',          detail: 'inclusive range' },
  { label: 'closeTo(value, delta)',  insert: 'closeTo(',         detail: 'numeric tolerance' },
  { label: 'lengthOf(number)',       insert: 'lengthOf(',        detail: 'length equals'  },
  { label: 'property(name, value?)', insert: "property('",       detail: 'property exists or equals' },
  { label: 'a(type)',                insert: "a('",              detail: 'typeof match'   },
  { label: 'an(type)',               insert: "an('",             detail: 'alias of a'     },
  { label: 'instanceOf(Ctor)',       insert: 'instanceOf(',      detail: 'instance check' },
  { label: 'match(regex)',           insert: 'match(',           detail: 'regex match'    },
  { label: 'keys(array)',            insert: 'keys([',           detail: 'has all keys'   },
  { label: 'key(name)',              insert: "key('",            detail: 'single key alias' },
  { label: 'string(text)',           insert: 'string(',          detail: 'string contains text' },
  // Chainable words
  { label: 'to',     insert: 'to',     detail: 'chain word' },
  { label: 'be',     insert: 'be',     detail: 'chain word' },
  { label: 'been',   insert: 'been',   detail: 'chain word' },
  { label: 'is',     insert: 'is',     detail: 'chain word' },
  { label: 'that',   insert: 'that',   detail: 'chain word' },
  { label: 'which',  insert: 'which',  detail: 'chain word' },
  { label: 'and',    insert: 'and',    detail: 'chain word' },
  { label: 'has',    insert: 'has',    detail: 'chain word' },
  { label: 'have',   insert: 'have',   detail: 'chain word' },
  { label: 'with',   insert: 'with',   detail: 'chain word' },
  { label: 'at',     insert: 'at',     detail: 'chain word' },
  { label: 'of',     insert: 'of',     detail: 'chain word' },
  { label: 'same',   insert: 'same',   detail: 'chain word' },
  { label: 'does',   insert: 'does',   detail: 'chain word' },
  { label: 'still',  insert: 'still',  detail: 'chain word' },
  { label: 'also',   insert: 'also',   detail: 'chain word' },
  { label: 'not',    insert: 'not',    detail: 'negate assertion' },
  { label: 'deep',   insert: 'deep',   detail: 'deep equality chain' },
];

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
  { label: 'test.skip(name)',       insert: 'test.skip(',           detail: 'void'       },
  { label: 'expect(value)',         insert: 'expect(',              detail: 'Assertion'  },
  { label: 'softExpect(value)',     insert: 'softExpect(',          detail: 'SoftAssertion' },
  { label: 'assertAll(label?)',     insert: 'assertAll(',           detail: 'void'       },
  { label: 'sendRequest(opts, cb)', insert: 'sendRequest(',         detail: 'void'       },
  { label: 'executeRequest(name)',  insert: "executeRequest('",      detail: 'Promise<void>' },
];

// ─── Context detection ────────────────────────────────────────────────────────

function getContext(textBefore: string, requestNames: string[], requestItems?: Array<{ id: string; name: string }>): { completions: Completion[]; prefix: string } | null {
  let m: RegExpMatchArray | null;

  // Most specific patterns first
  m = textBefore.match(/(?:apx|pm)\.response\.to\.have\.(\w*)$/);
  if (m) return { completions: RESPONSE_TO_HAVE, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.response\.to\.be\.(\w*)$/);
  if (m) return { completions: RESPONSE_TO_BE, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.response\.to\.(\w*)$/);
  if (m) return { completions: RESPONSE_TO, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.response\.headers\.(\w*)$/);
  if (m) return { completions: RESPONSE_HEADERS, prefix: m[1] };

  m = textBefore.match(/(?:apx|pm)\.test\.(\w*)$/);
  if (m) return { completions: TEST_FN, prefix: m[1] };

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

  // Expect-chain completions: triggered after expect(...). or after one or more chain segments.
  m = textBefore.match(/\)\.(?:(?:to|be|been|is|that|which|and|has|have|with|at|of|same|does|still|also|deep|not)\.)*(\w*)$/);
  if (m) return { completions: EXPECT_CHAIN, prefix: m[1] };

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
  // Request ID autocomplete inside pm.execution.setNextRequestById('...
  m = textBefore.match(/(?:apx|pm)\.execution\.setNextRequestById\(['"]([^'"]*)$/);
  if (m) {
    const prefix = m[1];
    const items = requestItems ?? [];
    const completions = items
      .filter(it => it.id.startsWith(prefix) || it.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(it => ({ label: `${it.id} (${it.name})`, insert: it.id, detail: 'id' }));
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
  onSave?: () => void;
  /** Called whenever a syntax check runs; receives true if there is an error */
  onSyntaxCheck?: (hasError: boolean) => void;
  rows?: number;
  placeholder?: string;
  /** Forward an external ref so the parent can read selectionStart/End for snippet insertion */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  className?: string;
  /** Request names from the current collection, for apx.executeRequest() autocomplete */
  requestNames?: string[];
  /** Request id+name pairs for setNextRequestById() autocomplete */
  requestItems?: Array<{ id: string; name: string }>;
  /** 'mock' uses the req/respond context; default uses the apx/pm context */
  variant?: 'default' | 'mock';
}

function checkJsSyntax(code: string): string | null {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return null;
  } catch (e) {
    return e instanceof SyntaxError ? e.message : String(e);
  }
}

export default function ScriptEditor({
  value,
  onChange,
  onSave,
  onSyntaxCheck,
  rows = 14,
  placeholder,
  textareaRef,
  className,
  requestNames,
  requestItems,
  variant = 'default',
}: ScriptEditorProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const ref = (textareaRef as React.RefObject<HTMLTextAreaElement>) ?? internalRef;

  const [ac, setAc] = useState<AcState | null>(null);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [syntaxOk, setSyntaxOk] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Run syntax check on mount so the error state is visible immediately when
  // switching to a tab that already has a script.
  useEffect(() => {
    if (!value.trim()) return;
    const err = checkJsSyntax(value);
    setSyntaxError(err);
    setSyntaxOk(err === null);
    onSyntaxCheck?.(err !== null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // intentionally only on mount

  const recompute = useCallback((el: HTMLTextAreaElement) => {
    const pos = el.selectionStart;
    const textBefore = el.value.substring(0, pos);
    const ctx = variant === 'mock'
      ? getMockContext(textBefore)
      : getContext(textBefore, requestNames ?? [], requestItems);
    if (!ctx) { setAc(null); return; }

    const filtered = ctx.completions
      .map((completion, index) => ({
        completion,
        index,
        score: getCompletionScore(completion, ctx.prefix),
      }))
      .filter((entry): entry is { completion: Completion; index: number; score: number } => entry.score !== null)
      .sort((a, b) => a.score - b.score || a.index - b.index || a.completion.label.localeCompare(b.completion.label))
      .map(entry => entry.completion);
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
  }, [requestNames, requestItems]);

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
    // Syntax check on Ctrl+S / Cmd+S
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      const err = checkJsSyntax(value);
      setSyntaxError(err);
      setSyntaxOk(err === null);
      onSyntaxCheck?.(err !== null);
      if (err === null) onSave?.();
      return;
    }
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
        onInput={e => { recompute(e.currentTarget); setSyntaxError(null); setSyntaxOk(false); }}
        onKeyDown={handleKeyDown}
        onClick={e => recompute(e.currentTarget)}
        onBlur={() => {
          if (!value.trim()) return;
          const err = checkJsSyntax(value);
          setSyntaxError(err);
          setSyntaxOk(err === null);
          onSyntaxCheck?.(err !== null);
        }}
        rows={rows}
        spellCheck={false}
        className={textareaClass}
        placeholder={placeholder}
      />

      {syntaxError && (
        <div className="flex items-start gap-2 mt-1 px-3 py-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-xs font-mono">
          <span className="shrink-0 font-bold">SyntaxError:</span>
          <span className="break-all">{syntaxError}</span>
        </div>
      )}
      {syntaxOk && !syntaxError && (
        <div className="flex items-center gap-2 mt-1 px-3 py-1.5 rounded bg-green-900/40 border border-green-700 text-green-300 text-xs">
          <span>✓ No syntax errors</span>
        </div>
      )}

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
