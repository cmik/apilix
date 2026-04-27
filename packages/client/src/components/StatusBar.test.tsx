// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import StatusBar from './StatusBar';
import type { ConsoleEntry } from '../types';

(globalThis as any).__APP_VERSION__ = '0.0.0-test';

afterEach(() => {
  cleanup();
});

const baseProps = {
  consoleOpen: false,
  onToggleConsole: () => {},
  logCount: 0,
  lastEntry: null as ConsoleEntry | null,
  serverStatus: 'online' as const,
};

describe('StatusBar update badge', () => {
  it('does not render update link when update props are not provided', () => {
    render(<StatusBar {...baseProps} />);

    expect(screen.queryByRole('link', { name: /available/i })).not.toBeInTheDocument();
  });

  it('renders update link when updateAvailable=true and latestVersion is provided', () => {
    render(<StatusBar {...baseProps} updateAvailable latestVersion="1.2.3" />);

    const link = screen.getByRole('link', { name: /v1\.2\.3 available/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://github.com/cmik/apilix/releases/latest');
  });

  it('does not render update link when updateAvailable=false even if latestVersion exists', () => {
    render(<StatusBar {...baseProps} updateAvailable={false} latestVersion="1.2.3" />);

    expect(screen.queryByRole('link', { name: /v1\.2\.3 available/i })).not.toBeInTheDocument();
  });
});
