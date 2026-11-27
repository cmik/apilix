// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const dispatch = vi.fn();
let settings: Record<string, unknown> = {};
vi.mock('../store', () => ({ useApp: () => ({ state: { settings }, dispatch }) }));
vi.mock('../api', () => ({ API_BASE: '/api' }));

import SettingsModal from './SettingsModal';

afterEach(() => { cleanup(); dispatch.mockClear(); });

describe('SettingsModal: schema validation time limit', () => {
  it('shows the default and dispatches the entered value', () => {
    settings = {};
    render(<SettingsModal onClose={() => {}} initialTab="requests" />);
    const input = screen.getByText(/Schema validation time limit/).parentElement!.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('2000');
    fireEvent.change(input, { target: { value: '5000' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'UPDATE_SETTINGS', payload: { schemaValidationTimeoutMs: 5000 } });
  });

  it('states the 100 to 10000 ms range', () => {
    settings = {};
    render(<SettingsModal onClose={() => {}} initialTab="requests" />);
    expect(screen.getByText(/Schema validation time limit \(ms\), 100 to 10000/)).toBeInTheDocument();
  });

  it('reflects a saved value', () => {
    settings = { schemaValidationTimeoutMs: 750 };
    render(<SettingsModal onClose={() => {}} initialTab="requests" />);
    expect((screen.getByText(/Schema validation time limit/).parentElement!.querySelector('input') as HTMLInputElement).value).toBe('750');
  });
});
