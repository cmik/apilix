// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import ScriptSnippetsLibrary from './ScriptSnippetsLibrary';
import { addCustomSnippet, loadCustomSnippets } from '../utils/customSnippets';

describe('ScriptSnippetsLibrary "My snippets"', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  const openLibrary = () => userEvent.click(screen.getByRole('button', { name: /Snippets/ }));

  it('has no My snippets category until the user saves one', async () => {
    render(<ScriptSnippetsLibrary target="test" onInsert={() => {}} />);
    await openLibrary();
    expect(screen.queryByText('My snippets')).toBeNull();
  });

  it('lists saved snippets first, inserts the code, and deletes on request', async () => {
    addCustomSnippet('test', { name: 'Check 200', code: 'apx.test("200", () => {});' });
    addCustomSnippet('prerequest', { name: 'Only pre', code: 'apx.environment.set("a", "1");' });
    const onInsert = vi.fn();
    render(<ScriptSnippetsLibrary target="test" onInsert={onInsert} />);
    await openLibrary();
    expect(screen.getByText('My snippets')).toBeInTheDocument();
    const firstCategory = screen.getAllByRole('button').find(b => b.className.includes('w-full flex items-center justify-between'));
    expect(firstCategory).toHaveTextContent('My snippets');
    expect(screen.queryByText('Only pre')).toBeNull();
    await userEvent.click(screen.getByText('My snippets'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Insert' })[0]);
    expect(onInsert).toHaveBeenCalledWith('apx.test("200", () => {});');
    await openLibrary(); // the category stays expanded
    await userEvent.click(screen.getByRole('button', { name: 'Delete snippet Check 200' }));
    expect(loadCustomSnippets('test')).toEqual([]);
    expect(screen.queryByText('My snippets')).toBeNull();
  });

  it('shows a snippet saved while the library is mounted', async () => {
    render(<ScriptSnippetsLibrary target="test" onInsert={() => {}} />);
    await openLibrary();
    act(() => { addCustomSnippet('test', { name: 'Fresh', code: 'x' }); });
    expect(screen.getByText('My snippets')).toBeInTheDocument();
  });
});
