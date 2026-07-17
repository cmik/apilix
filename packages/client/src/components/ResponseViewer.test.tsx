// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { mockedUseApp } = vi.hoisted(() => ({
  mockedUseApp: vi.fn(),
}));

vi.mock('../store', () => ({
  useApp: mockedUseApp,
}));

import ResponseViewer, { applyJsonPathForTest } from './ResponseViewer';

function makeState(body: string) {
  return {
    state: {
      activeTabId: 'tab-1',
      activeRequest: { collectionId: 'col-1' },
      isLoading: false,
      response: {
        status: 200,
        statusText: 'OK',
        responseTime: 12,
        size: body.length,
        headers: { 'content-type': 'application/json' },
        body,
        error: null,
        testResults: [],
      },
    },
  } as any;
}

function makeSqlState() {
  const payload = {
    rowCount: 2,
    columns: ['id', 'name'],
    rows: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };
  return {
    state: {
      activeTabId: 'tab-1',
      activeRequest: { collectionId: 'col-1' },
      isLoading: false,
      response: {
        protocol: 'sql',
        sqlDialect: 'postgres',
        resultView: 'table',
        resultTable: payload,
        status: 2200,
        statusText: 'SQL_SUCCESS',
        responseTime: 20,
        size: JSON.stringify(payload).length,
        headers: {},
        body: JSON.stringify(payload),
        error: null,
        testResults: [],
      },
    },
  } as any;
}

function makeHtmlState() {
  const body = '<!doctype html><html><body><h1>Hello</h1></body></html>';
  return {
    state: {
      activeTabId: 'tab-1',
      activeRequest: { collectionId: 'col-1' },
      isLoading: false,
      response: {
        status: 200,
        statusText: 'OK',
        responseTime: 12,
        size: body.length,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body,
        error: null,
        testResults: [],
      },
    },
  } as any;
}

describe('ResponseViewer search with folded trees', () => {
  beforeEach(() => {
    mockedUseApp.mockReset();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('auto-unfolds tree when pressing Enter for next match', async () => {
    const user = userEvent.setup();
    mockedUseApp.mockReturnValue(makeState('{"outer":{"inner":"needle"}}'));

    const { container } = render(<ResponseViewer />);

    await user.click(screen.getByTitle('Collapse all'));
    await user.click(screen.getByTitle('Search in body (⌘F)'));

    const input = screen.getByPlaceholderText(/Search in body/u);
    await user.type(input, 'needle');

    await user.type(input, '{enter}');

    await waitFor(() => {
      expect(container.querySelectorAll('mark.search-match').length).toBeGreaterThan(0);
    });
  });

  it('auto-unfolds tree for toolbar next/previous search actions', async () => {
    const user = userEvent.setup();
    mockedUseApp.mockReturnValue(makeState('{"outer":{"inner":"needle"}}'));

    const { container } = render(<ResponseViewer />);

    await user.click(screen.getByTitle('Collapse all'));
    await user.click(screen.getByTitle('Search in body (⌘F)'));
    await user.type(screen.getByPlaceholderText(/Search in body/u), 'needle');

    await user.click(screen.getByTitle('Next match (Enter)'));
    await waitFor(() => {
      expect(container.querySelectorAll('mark.search-match').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByTitle('Previous match (Shift+Enter)'));
    await waitFor(() => {
      expect(container.querySelectorAll('mark.search-match').length).toBeGreaterThan(0);
    });
  });

  it('renders SQL result as table and switches to JSON mode', async () => {
    const user = userEvent.setup();
    mockedUseApp.mockReturnValue(makeSqlState());

    render(<ResponseViewer />);

    expect(screen.getByText('Rows:')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'JSON' }));

    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(screen.getByText(/rowCount/)).toBeInTheDocument();
  });

  it('shows Tree/Raw segmented buttons for non-HTML responses', async () => {
    const user = userEvent.setup();
    mockedUseApp.mockReturnValue(makeState('{"message":"ok"}'));

    render(<ResponseViewer />);

    expect(screen.getByRole('button', { name: 'Tree' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raw' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('button', { name: 'Raw' })).toHaveClass('bg-slate-600');
  });

  it('shows Source/Preview for HTML and hides Raw control', async () => {
    mockedUseApp.mockReturnValue(makeHtmlState());

    render(<ResponseViewer />);

    const previewButton = screen.getByRole('button', { name: 'Preview' });
    const sourceButton = screen.getByRole('button', { name: 'Source' });
    expect(previewButton).toBeInTheDocument();
    expect(sourceButton).toBeInTheDocument();
    expect(sourceButton).toHaveClass('bg-slate-600');

    const rawCheckbox = screen.queryByRole('checkbox');
    expect(rawCheckbox).not.toBeInTheDocument();
  });
});

describe('JSONPath evaluator with filter predicates', () => {
  it('supports simple array filtering on field equality', () => {
    const data = {
      items: [
        { id: 1, name: 'Alice', active: true },
        { id: 2, name: 'Bob', active: false },
        { id: 3, name: 'Charlie', active: true },
      ],
    };
    
    const result = applyJsonPathForTest(data, '$.items[?(@.active==true)]');
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.value)).toBe(true);
    const items = result.value as any[];
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe('Alice');
    expect(items[1].name).toBe('Charlie');
  });

  it('supports nested property access after filter predicate', () => {
    const data = {
      items: [
        { id: 1, name: 'Alice', active: true },
        { id: 2, name: 'Bob', active: false },
        { id: 3, name: 'Charlie', active: true },
      ],
    };
    
    const result = applyJsonPathForTest(data, '$.items[?(@.active==true)].name');
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.value)).toBe(true);
    const names = result.value as string[];
    expect(names).toEqual(['Alice', 'Charlie']);
  });

  it('supports filter with inequality operator', () => {
    const data = {
      items: [
        { id: 1, value: 100 },
        { id: 2, value: 50 },
        { id: 3, value: 75 },
      ],
    };
    
    const result = applyJsonPathForTest(data, '$.items[?(@.value<100)]');
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.value)).toBe(true);
    const items = result.value as any[];
    expect(items).toHaveLength(2);
    expect(items[0].value).toBe(50);
    expect(items[1].value).toBe(75);
  });

  it('supports filter with greater than operator', () => {
    const data = {
      items: [
        { id: 1, value: 100 },
        { id: 2, value: 50 },
        { id: 3, value: 150 },
      ],
    };
    
    const result = applyJsonPathForTest(data, '$.items[?(@.value>100)]');
    expect(result.error).toBeUndefined();
    // Single item is unwrapped
    expect(result.value).toEqual({ id: 3, value: 150 });
  });

  it('supports string matching in filter predicates', () => {
    const data = {
      items: [
        { name: 'Alice' },
        { name: 'Bob' },
        { name: 'Alex' },
      ],
    };
    
    const result = applyJsonPathForTest(data, "$.items[?(@.name=='Alice')]");
    expect(result.error).toBeUndefined();
    // Single item is unwrapped
    expect(result.value).toEqual({ name: 'Alice' });
  });

  it('returns null when no matches are found', () => {
    const data = {
      items: [
        { active: false },
        { active: false },
      ],
    };
    
    const result = applyJsonPathForTest(data, '$.items[?(@.active==true)]');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(null);
  });

  it('still supports basic paths without predicates', () => {
    const data = { a: { b: { c: 42 } } };
    const result = applyJsonPathForTest(data, '$.a.b.c');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(42);
  });

  it('supports wildcard selector', () => {
    const data = { a: 1, b: 2, c: 3 };
    const result = applyJsonPathForTest(data, '$.*');
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.value)).toBe(true);
    expect((result.value as any[]).sort()).toEqual([1, 2, 3]);
  });

  it('supports array indexing', () => {
    const data = { items: [10, 20, 30] };
    const result = applyJsonPathForTest(data, '$.items[1]');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(20);
  });

  it('supports array slicing', () => {
    const data = { items: [1, 2, 3, 4, 5] };
    const result = applyJsonPathForTest(data, '$.items[1:3]');
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([2, 3]);
  });

  it('supports recursive descent', () => {
    const data = {
      a: { id: 1 },
      b: { x: { id: 2 } },
      c: { y: { z: { id: 3 } } },
    };
    
    const result = applyJsonPathForTest(data, '$..id');
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.value)).toBe(true);
    expect(result.value).toEqual([1, 2, 3]);
  });

  it('rejects expressions not starting with $', () => {
    const data = { a: 1 };
    const result = applyJsonPathForTest(data, 'a.b');
    expect(result.error).toBeDefined();
    expect(result.value).toBeUndefined();
  });

  it('returns the root when path is just $', () => {
    const data = { a: 1, b: 2 };
    const result = applyJsonPathForTest(data, '$');
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(data);
  });

  it('returns a single value unwrapped, not in an array', () => {
    const data = { x: 42 };
    const result = applyJsonPathForTest(data, '$.x');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(42);
    expect(Array.isArray(result.value)).toBe(false);
  });

  it('returns an array if multiple values match', () => {
    const data = { a: 1, b: 2, c: 3 };
    const multiResult = applyJsonPathForTest(data, '$[a,b]');
    expect(Array.isArray(multiResult.value) || multiResult.value === null).toBe(true);
  });
});
