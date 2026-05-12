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

import ResponseViewer from './ResponseViewer';

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

describe('ResponseViewer search with folded trees', () => {
  beforeEach(() => {
    mockedUseApp.mockReset();
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

    expect(container.querySelectorAll('mark.search-match')).toHaveLength(0);

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

    expect(container.querySelectorAll('mark.search-match')).toHaveLength(0);

    await user.click(screen.getByTitle('Next match (Enter)'));
    await waitFor(() => {
      expect(container.querySelectorAll('mark.search-match').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByTitle('Collapse all'));
    await waitFor(() => {
      expect(container.querySelectorAll('mark.search-match')).toHaveLength(0);
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
});
