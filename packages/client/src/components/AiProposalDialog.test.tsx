// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { CollectionItem } from '../types';
import type { AiGenerateRequestResult } from '../utils/ai/aiTypes';
import AiProposalDialog from './AiProposalDialog';

afterEach(() => cleanup());

const result = (over: Partial<AiGenerateRequestResult> = {}, draft: Partial<AiGenerateRequestResult['draft']> = {}): AiGenerateRequestResult => ({
  draft: {
    name: 'Create user', method: 'POST', url: '{{baseUrl}}/users',
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    body: { mode: 'raw', raw: '{"name":"Ada"}' },
    tests: "apx.test('Status is 201', () => {\n  apx.expect(apx.response.code).to.equal(201);\n});",
    ...draft,
  },
  validation: { validated: true, errors: [] }, warnings: [], retried: false, ...over,
});

const handlers = () => ({ onApply: vi.fn(), onDiscard: vi.fn(), onRegenerate: vi.fn() });

describe('AiProposalDialog', () => {
  it('previews a new request, badges it as AI-generated and applies only on click', () => {
    const h = handlers();
    render(<AiProposalDialog mode="create" result={result()} targetLabel="the folder Users" {...h} />);
    expect(screen.getByText('AI-generated')).toBeInTheDocument();
    expect(screen.getByText('POST')).toBeInTheDocument();
    expect(screen.getByText('{{baseUrl}}/users')).toBeInTheDocument();
    expect(screen.getByText(/It will be added to the folder Users/)).toBeInTheDocument();
    expect(screen.getByText('Tests')).toBeInTheDocument();
    expect(h.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(h.onApply).toHaveBeenCalledTimes(1);
    const item = h.onApply.mock.calls[0][0] as CollectionItem;
    expect(item.name).toBe('Create user');
    expect(item.request?.method).toBe('POST');
    expect(item.event?.[0].listen).toBe('test');
  });

  it('flags non-validated scripts and renames the action', () => {
    const h = handlers();
    render(<AiProposalDialog mode="create" result={result({ validation: { validated: false, errors: [{ field: 'tests', reason: 'syntax error: Unexpected end of input' }] } })} {...h} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Not validated');
    expect(screen.getByRole('alert')).toHaveTextContent('Unexpected end of input');
    expect(screen.getByRole('button', { name: 'Apply anyway' })).toBeInTheDocument();
  });

  it('ignore, escape and regenerate call their handlers and never apply', () => {
    const h = handlers();
    render(<AiProposalDialog mode="create" result={result()} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(h.onRegenerate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onDiscard).toHaveBeenCalledTimes(2);
    expect(h.onApply).not.toHaveBeenCalled();
  });

  it('neutralises images and links in model-written text', () => {
    const h = handlers();
    render(<AiProposalDialog mode="create" result={result({ warnings: ['See ![x](http://evil.test/a.png) and [click](http://evil.test)'] }, { name: 'Hi ![x](http://evil.test/b.png)' })} {...h} />);
    expect(document.body.innerHTML).not.toContain('evil.test');
    expect(document.querySelector('img')).toBeNull();
  });

  it('modify mode: shows a diff against the current request, keeps its name, and says nothing is saved', () => {
    const base: CollectionItem = {
      id: 'r1', name: 'My request',
      request: { method: 'GET', url: { raw: 'https://api.test/users' }, header: [] },
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: ["apx.test('ok', () => {});"] } }],
    };
    const h = handlers();
    render(<AiProposalDialog mode="modify" base={base} result={result({}, { name: 'Renamed by model', method: 'GET', url: 'https://api.test/users?page=1', headers: [{ key: 'X-Tenant', value: '{{tenant}}' }], body: { mode: 'none' }, tests: "apx.test('ok', () => {});\napx.test('paged', () => {});" })} {...h} />);
    expect(screen.getByText(/replaces?|updates the editor only/i)).toBeInTheDocument();
    expect(screen.getByText('Headers')).toBeInTheDocument();
    expect(screen.getByText(/X-Tenant: \{\{tenant\}\}/)).toBeInTheDocument();
    expect(screen.getByText('URL')).toBeInTheDocument();
    expect(screen.queryByText('Name')).toBeNull();
    const added = screen.getByText("apx.test('paged', () => {});");
    expect(added.className).toContain('text-green');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const item = h.onApply.mock.calls[0][0] as CollectionItem;
    expect(item.id).toBe('r1');
    expect(item.name).toBe('My request');
  });

  it('modify mode: disables Apply when the proposal changes nothing', () => {
    const base: CollectionItem = { id: 'r1', name: 'R', request: { method: 'GET', url: { raw: 'https://api.test/x' }, header: [] } };
    const h = handlers();
    render(<AiProposalDialog mode="modify" base={base} result={result({}, { method: 'GET', url: 'https://api.test/x', headers: [], body: { mode: 'none' }, tests: '' })} {...h} />);
    expect(screen.getByText(/proposes no change/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('shows a refused script as removed, with no way to apply it', () => {
    const h = handlers();
    render(<AiProposalDialog mode="create" result={result({ validation: { validated: true, errors: [], removed: [{ field: 'tests', reason: '"constructor" is not allowed in a validated script' }] } }, { tests: '' })} {...h} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Script refused for security');
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was run');
    expect(screen.queryByRole('button', { name: 'Apply anyway' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const item = h.onApply.mock.calls[0][0] as CollectionItem;
    expect(item.event ?? []).toEqual([]);
  });

  it('keeps "Apply anyway" only for a script that passed the screen and failed its test run', () => {
    render(<AiProposalDialog mode="create" result={result({ validation: { validated: false, errors: [{ field: 'tests', reason: 'script error: x is not defined' }] } })} {...handlers()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('passed the security screen but failed their test run');
    expect(screen.getByRole('button', { name: 'Apply anyway' })).toBeInTheDocument();
  });

  it('blocks Apply behind an acknowledgement when secrets would go to an unfamiliar host', () => {
    const h = handlers();
    const risky = result({}, { url: 'https://collect.evil.test/in', headers: [{ key: 'X-Api-Key', value: '{{apiKey}}' }] });
    render(<AiProposalDialog mode="create" result={risky} secretNames={['apiKey']} knownHosts={['api.shop.test']} {...h} />);
    expect(screen.getByText(/send secrets to an unfamiliar host/)).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(h.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(h.onApply).toHaveBeenCalledTimes(1);
  });

  it('does not block for {{baseUrl}}, a known host, or a host without secrets', () => {
    const headers = [{ key: 'X-Api-Key', value: '{{apiKey}}' }];
    const { rerender } = render(<AiProposalDialog mode="create" result={result({}, { headers })} secretNames={['apiKey']} knownHosts={[]} {...handlers()} />);
    expect(screen.queryByText(/unfamiliar host/)).toBeNull();
    rerender(<AiProposalDialog mode="create" result={result({}, { url: 'https://api.shop.test/x', headers })} secretNames={['apiKey']} knownHosts={['api.shop.test']} {...handlers()} />);
    expect(screen.queryByText(/unfamiliar host/)).toBeNull();
    rerender(<AiProposalDialog mode="create" result={result({}, { url: 'https://other.test/x' })} secretNames={['apiKey']} knownHosts={[]} {...handlers()} />);
    expect(screen.queryByText(/unfamiliar host/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('modify mode says what is kept as is', () => {
    const base: CollectionItem = {
      id: 'r1', name: 'Upload',
      request: {
        method: 'POST', url: { raw: 'https://api.shop.test/files/:id', path: ['files', ':id'], variable: [{ key: 'id', value: '42' }] },
        header: [{ key: 'X-Debug', value: '1', disabled: true }, { key: 'Accept', value: 'application/json' }],
        body: { mode: 'formdata', formdata: [{ key: 'file', value: '', type: 'file' }, { key: 'note', value: 'a', type: 'text' }] },
      },
    };
    render(<AiProposalDialog mode="modify" base={base} result={result({}, { method: 'POST', url: 'https://api.shop.test/files/:id', headers: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Tenant', value: 'acme' }], body: { mode: 'formdata', formdata: [{ key: 'note', value: 'b' }] } })} {...handlers()} />);
    expect(screen.getByRole('note')).toHaveTextContent('1 disabled header, 1 file field, 1 path variable');
  });
});
