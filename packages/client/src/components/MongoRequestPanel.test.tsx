// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { UsedVariablesSection } from './MongoRequestPanel';
import type { MongoUsedVariable } from '../utils/variableResolver';

afterEach(() => {
  cleanup();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function envVar(name: string, value: string): MongoUsedVariable {
  return { name, resolvedValue: value, scope: 'ENV', isEditable: true };
}
function collVar(name: string, value: string): MongoUsedVariable {
  return { name, resolvedValue: value, scope: 'COLL', isEditable: true };
}
function globalVar(name: string, value: string): MongoUsedVariable {
  return { name, resolvedValue: value, scope: 'GLOBAL', isEditable: true };
}
function collDefVar(name: string, value: string): MongoUsedVariable {
  return { name, resolvedValue: value, scope: 'COLLECTION_DEF', isEditable: false };
}
function dynamicVar(name: string): MongoUsedVariable {
  return { name, resolvedValue: '', scope: 'DYNAMIC', isEditable: false };
}
function unresolvedVar(name: string): MongoUsedVariable {
  return { name, resolvedValue: '', scope: 'UNRESOLVED', isEditable: true };
}

// ─── rendering ───────────────────────────────────────────────────────────────

describe('UsedVariablesSection — rendering', () => {
  it('renders nothing when usedVars is empty', () => {
    const { container } = render(
      <UsedVariablesSection usedVars={[]} hasActiveEnv={true} onVarEdit={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the "Used Variables" header and total count', () => {
    render(
      <UsedVariablesSection
        usedVars={[envVar('mongoUri', 'mongodb://localhost'), collVar('db', 'app')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.getByText('Used Variables')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows unresolved count badge when there are unresolved vars', () => {
    render(
      <UsedVariablesSection
        usedVars={[unresolvedVar('missing'), envVar('present', 'val')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.getByText('1 unresolved')).toBeInTheDocument();
  });

  it('does not show unresolved badge when all vars are resolved', () => {
    render(
      <UsedVariablesSection
        usedVars={[envVar('mongoUri', 'mongodb://localhost')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.queryByText(/unresolved/i)).not.toBeInTheDocument();
  });

  it('renders scope badges for ENV, COLL and GLOBAL', () => {
    render(
      <UsedVariablesSection
        usedVars={[envVar('e', '1'), collVar('c', '2'), globalVar('g', '3')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.getByText('ENV')).toBeInTheDocument();
    expect(screen.getByText('COLL')).toBeInTheDocument();
    expect(screen.getByText('GLOBAL')).toBeInTheDocument();
  });

  it('renders DYNAMIC scope as read-only "auto-generated at send"', () => {
    render(
      <UsedVariablesSection
        usedVars={[dynamicVar('$guid')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.getByText('auto-generated at send')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('renders COLLECTION_DEF scope as read-only with "(collection settings)" hint', () => {
    render(
      <UsedVariablesSection
        usedVars={[collDefVar('staticHost', 'prod.example.com')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.getByText('(collection settings)')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the current resolvedValue in the input for an editable var', () => {
    render(
      <UsedVariablesSection
        usedVars={[envVar('host', 'localhost')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('localhost');
  });

  it('shows UNRESOLVED scope as a scope selector <select> instead of a badge', () => {
    render(
      <UsedVariablesSection
        usedVars={[unresolvedVar('newKey')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
  });

  it('defaults UNRESOLVED scope selector to "env" when there is an active env', () => {
    render(
      <UsedVariablesSection
        usedVars={[unresolvedVar('newKey')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox')).toHaveValue('env');
  });

  it('defaults UNRESOLVED scope selector to "global" when there is no active env', () => {
    render(
      <UsedVariablesSection
        usedVars={[unresolvedVar('newKey')]}
        hasActiveEnv={false}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox')).toHaveValue('global');
  });

  it('hides the ENV option in the UNRESOLVED scope selector when hasActiveEnv is false', () => {
    render(
      <UsedVariablesSection
        usedVars={[unresolvedVar('newKey')]}
        hasActiveEnv={false}
        onVarEdit={vi.fn()}
      />
    );
    const select = screen.getByRole('combobox');
    expect(within(select).queryByRole('option', { name: 'ENV' })).not.toBeInTheDocument();
  });
});

// ─── interaction ─────────────────────────────────────────────────────────────

describe('UsedVariablesSection — interaction', () => {
  it('calls onVarEdit with the original value and correct scope when Apply is clicked without editing', async () => {
    const user = userEvent.setup();
    const onVarEdit = vi.fn();
    render(
      <UsedVariablesSection
        usedVars={[envVar('host', 'localhost')]}
        hasActiveEnv={true}
        onVarEdit={onVarEdit}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Apply value' }));
    expect(onVarEdit).toHaveBeenCalledOnce();
    expect(onVarEdit).toHaveBeenCalledWith('host', 'localhost', 'env');
  });

  it('calls onVarEdit with the edited value when Apply is clicked after typing', async () => {
    const user = userEvent.setup();
    const onVarEdit = vi.fn();
    render(
      <UsedVariablesSection
        usedVars={[envVar('host', 'localhost')]}
        hasActiveEnv={true}
        onVarEdit={onVarEdit}
      />
    );
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'prod.example.com');
    await user.click(screen.getByRole('button', { name: 'Apply value' }));
    expect(onVarEdit).toHaveBeenCalledWith('host', 'prod.example.com', 'env');
  });

  it('calls onVarEdit when Enter is pressed inside the input', async () => {
    const user = userEvent.setup();
    const onVarEdit = vi.fn();
    render(
      <UsedVariablesSection
        usedVars={[envVar('host', 'localhost')]}
        hasActiveEnv={true}
        onVarEdit={onVarEdit}
      />
    );
    const input = screen.getByRole('textbox');
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onVarEdit).toHaveBeenCalledOnce();
  });

  it('routes COLL-scope Apply to onVarEdit with scope "coll"', async () => {
    const user = userEvent.setup();
    const onVarEdit = vi.fn();
    render(
      <UsedVariablesSection
        usedVars={[collVar('db', 'mydb')]}
        hasActiveEnv={true}
        onVarEdit={onVarEdit}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Apply value' }));
    expect(onVarEdit).toHaveBeenCalledWith('db', 'mydb', 'coll');
  });

  it('routes GLOBAL-scope Apply to onVarEdit with scope "global"', async () => {
    const user = userEvent.setup();
    const onVarEdit = vi.fn();
    render(
      <UsedVariablesSection
        usedVars={[globalVar('token', 'abc123')]}
        hasActiveEnv={true}
        onVarEdit={onVarEdit}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Apply value' }));
    expect(onVarEdit).toHaveBeenCalledWith('token', 'abc123', 'global');
  });

  it('uses the selected scope when creating an UNRESOLVED variable', async () => {
    const user = userEvent.setup();
    const onVarEdit = vi.fn();
    render(
      <UsedVariablesSection
        usedVars={[unresolvedVar('newKey')]}
        hasActiveEnv={true}
        onVarEdit={onVarEdit}
      />
    );
    const input = screen.getByRole('textbox');
    await user.type(input, 'someValue');
    await user.selectOptions(screen.getByRole('combobox'), 'coll');
    await user.click(screen.getByRole('button', { name: 'Create variable' }));
    expect(onVarEdit).toHaveBeenCalledWith('newKey', 'someValue', 'coll');
  });

  it('collapses the table when the header button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <UsedVariablesSection
        usedVars={[envVar('host', 'localhost')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    // Table is visible before collapse
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /used variables/i }));
    // Table should no longer be rendered
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not call onVarEdit for DYNAMIC vars (no button rendered)', () => {
    render(
      <UsedVariablesSection
        usedVars={[dynamicVar('$guid')]}
        hasActiveEnv={true}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /apply|create/i })).not.toBeInTheDocument();
  });
});

// ─── secret masking ───────────────────────────────────────────────────────────

describe('UsedVariablesSection — secret masking', () => {
  it('masks an ENV secret: input type is "password" by default', () => {
    const { container } = render(
      <UsedVariablesSection
        usedVars={[envVar('apiKey', 'super-secret')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={vi.fn()}
      />
    );
    const input = container.querySelector('input[name], input[type]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe('password');
  });

  it('shows eye (reveal) button for a secret variable', () => {
    render(
      <UsedVariablesSection
        usedVars={[envVar('apiKey', 'super-secret')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Reveal value' })).toBeInTheDocument();
  });

  it('does not show an eye button for a non-secret variable', () => {
    render(
      <UsedVariablesSection
        usedVars={[envVar('host', 'localhost')]}
        hasActiveEnv={true}
        secretKeys={new Set()} // host is not secret
        onVarEdit={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /reveal|hide/i })).not.toBeInTheDocument();
  });

  it('reveals the value (type becomes "text") when the eye button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <UsedVariablesSection
        usedVars={[envVar('apiKey', 'super-secret')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Reveal value' }));
    expect(screen.getByDisplayValue('super-secret')).toHaveAttribute('type', 'text');
  });

  it('switches from "Reveal value" to "Hide value" button after reveal', async () => {
    const user = userEvent.setup();
    render(
      <UsedVariablesSection
        usedVars={[envVar('apiKey', 'super-secret')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Reveal value' }));
    expect(screen.getByRole('button', { name: 'Hide value' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal value' })).not.toBeInTheDocument();
  });

  it('re-masks the value (type back to "password") when Hide is clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UsedVariablesSection
        usedVars={[envVar('apiKey', 'super-secret')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Reveal value' }));
    await user.click(screen.getByRole('button', { name: 'Hide value' }));
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('non-secret variables are not affected when secretKeys is provided', () => {
    render(
      <UsedVariablesSection
        usedVars={[envVar('host', 'localhost'), envVar('apiKey', 'secret')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={vi.fn()}
      />
    );
    const inputs = screen.getAllByRole('textbox', { hidden: true });
    const hostInput = inputs.find(i => i.getAttribute('value') === 'localhost');
    expect(hostInput).toHaveAttribute('type', 'text');
  });

  it('calls onVarEdit correctly for a revealed secret after editing', async () => {
    const user = userEvent.setup();
    const onVarEdit = vi.fn();
    render(
      <UsedVariablesSection
        usedVars={[envVar('apiKey', 'old-secret')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={onVarEdit}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Reveal value' }));
    const input = screen.getByDisplayValue('old-secret');
    await user.clear(input);
    await user.type(input, 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Apply value' }));
    expect(onVarEdit).toHaveBeenCalledWith('apiKey', 'new-secret', 'env');
  });

  it('resets revealed state when secretKeys prop changes (simulating env switch)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <UsedVariablesSection
        usedVars={[envVar('apiKey', 'secret-a')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={vi.fn()}
      />
    );
    // Reveal the key
    await user.click(screen.getByRole('button', { name: 'Reveal value' }));
    expect(screen.getByRole('button', { name: 'Hide value' })).toBeInTheDocument();

    // Simulate environment switch by passing a new Set reference
    rerender(
      <UsedVariablesSection
        usedVars={[envVar('apiKey', 'secret-b')]}
        hasActiveEnv={true}
        secretKeys={new Set(['apiKey'])}
        onVarEdit={vi.fn()}
      />
    );
    // After the rerender the key should be masked again
    expect(screen.getByRole('button', { name: 'Reveal value' })).toBeInTheDocument();
  });
});
