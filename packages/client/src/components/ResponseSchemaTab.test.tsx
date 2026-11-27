// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ResponseSchema, RequestResponse, CollectionItem } from '../types';

const dispatch = vi.fn();
let schemas: ResponseSchema[] = [];
let activeItem: CollectionItem | null = null;
let runMode: 'off' | 'warn' | 'strict' = 'warn';

vi.mock('../store', () => ({
  generateId: () => 'new-id',
  useApp: () => ({
    state: { responseSchemas: schemas, activeRequest: activeItem ? { collectionId: 'c1', item: activeItem } : null, schemaRunMode: runMode },
    dispatch,
  }),
}));

const inferSchema = vi.fn();
const validateSchema = vi.fn();
vi.mock('../api', () => ({
  inferSchema: (...a: unknown[]) => inferSchema(...a),
  validateSchema: (...a: unknown[]) => validateSchema(...a),
}));

import ResponseSchemaTab, { SchemaBadge } from './ResponseSchemaTab';
import SchemaEditorModal from './SchemaEditorModal';

const mk = (id: string, name: string): ResponseSchema => ({ id, name, schema: { type: 'object' }, version: 1 });
const response = (body: string, status = 200): RequestResponse => ({ status, statusText: 'OK', headers: {}, body, size: body.length, responseTime: 5, testResults: [], error: null } as unknown as RequestResponse);
const item = (links: Array<{ schemaId: string; match: string }> = []): CollectionItem => ({
  id: 'r1', name: 'Get user', request: { method: 'GET', url: { raw: 'http://x' }, ...(links.length ? { apilix: { schemaLinks: links } } : {}) },
});

beforeEach(() => { dispatch.mockReset(); inferSchema.mockReset(); validateSchema.mockReset(); schemas = []; activeItem = null; runMode = 'warn'; });
afterEach(() => cleanup());

describe('SchemaEditorModal', () => {
  it('blocks save on a duplicate name and on invalid JSON', () => {
    const onSave = vi.fn();
    render(<SchemaEditorModal existing={[mk('a', 'User')]} onSave={onSave} onClose={() => {}} />);
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'user' } });
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Order' } });
    expect(save).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('JSON Schema'), { target: { value: '{bad' } });
    expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('JSON Schema'), { target: { value: '{"type":"string"}' } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ name: 'Order', description: '', schema: { type: 'string' } });
  });

  it('notes 2019/2020 keywords that the validator ignores, without blocking save', () => {
    render(<SchemaEditorModal existing={[]} initial={mk('a', 'User')} onSave={() => {}} onClose={() => {}} />);
    expect(screen.queryByTestId('schema-ignored-keywords')).toBeNull();
    fireEvent.change(screen.getByLabelText('JSON Schema'), { target: { value: '{"type":"array","prefixItems":[{"type":"string"}]}' } });
    expect(screen.getByTestId('schema-ignored-keywords')).toHaveTextContent(/prefixItems/);
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('tests the schema against the last response and lists violations', async () => {
    validateSchema.mockResolvedValue({ valid: false, errors: [{ path: '/id', keyword: 'type', message: 'must be integer' }] });
    render(<SchemaEditorModal existing={[]} initial={mk('a', 'User')} sampleBody='{"id":"x"}' onSave={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Test against last response/ }));
    expect(await screen.findByText(/\/id must be integer/)).toBeInTheDocument();
  });
});

describe('ResponseSchemaTab', () => {
  it('lists links and dispatches changes', () => {
    schemas = [mk('a', 'User'), mk('b', 'Error')];
    render(<ResponseSchemaTab collectionId="c1" item={item([{ schemaId: 'a', match: '200' }])} response={null} />);
    expect(screen.getAllByTestId('schema-link-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'REQUEST_SET_SCHEMA_LINKS', payload: { collectionId: 'c1', requestId: 'r1', links: [{ schemaId: 'a', match: '200' }, { schemaId: 'a', match: 'default' }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'REQUEST_SET_SCHEMA_LINKS', payload: { collectionId: 'c1', requestId: 'r1', links: [] } });
  });

  it('flags an invalid match with a message and does not save it; a valid one is saved', () => {
    schemas = [mk('a', 'User')];
    render(<ResponseSchemaTab collectionId="c1" item={item([{ schemaId: 'a', match: '200' }])} response={null} />);
    const input = screen.getByLabelText('Status match');
    expect(screen.queryByRole('alert')).toBeNull();
    dispatch.mockClear();
    for (const bad of ['20', '6xx', 'abc', '2000', '']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(screen.getByRole('alert')).toHaveTextContent(/Invalid match, not saved/);
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '4xx' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({ type: 'REQUEST_SET_SCHEMA_LINKS', payload: { collectionId: 'c1', requestId: 'r1', links: [{ schemaId: 'a', match: '4xx' }] } });
  });

  it('shows the message for an already-invalid stored match', () => {
    schemas = [mk('a', 'User')];
    render(<ResponseSchemaTab collectionId="c1" item={item([{ schemaId: 'a', match: 'bogus' }])} response={null} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('infers from the last response, then saves and links the new schema to its status', async () => {
    inferSchema.mockResolvedValue({ type: 'object', properties: { id: { type: 'integer' } } });
    render(<ResponseSchemaTab collectionId="c1" item={item()} response={response('{"id":1}')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Infer from last response' }));
    await screen.findByRole('dialog');
    expect(inferSchema).toHaveBeenCalledWith({ bodies: ['{"id":1}'] }, { formats: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const add = dispatch.mock.calls.find(c => c[0].type === 'SCHEMA_ADD')![0];
    expect(add.payload).toMatchObject({ id: 'new-id', name: 'Get user 200', version: 1, source: 'inferred' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'REQUEST_SET_SCHEMA_LINKS', payload: { collectionId: 'c1', requestId: 'r1', links: [{ schemaId: 'new-id', match: '200' }] } });
  });

  it('disables inference without a JSON response and linking for unsaved requests', () => {
    render(<ResponseSchemaTab collectionId="" item={item()} response={response('not json')} />);
    expect(screen.getByRole('button', { name: 'Infer from last response' })).toBeDisabled();
    expect(screen.getByText(/Save this request in a collection/)).toBeInTheDocument();
  });
});

describe('SchemaBadge', () => {
  it('shows a violation badge for the linked schema and nothing without a link or when off', async () => {
    schemas = [mk('a', 'User')];
    activeItem = item([{ schemaId: 'a', match: '2xx' }]);
    validateSchema.mockResolvedValue({ valid: false, errors: [{ path: '/id', keyword: 'type', message: 'must be integer' }] });
    const { rerender } = render(<SchemaBadge response={response('{"id":"x"}')} />);
    expect(await screen.findByTestId('schema-badge')).toHaveTextContent('User: 1 violation');
    rerender(<SchemaBadge response={response('{"id":"x"}', 404)} />);
    await waitFor(() => expect(screen.queryByTestId('schema-badge')).not.toBeInTheDocument());
    cleanup();
    runMode = 'off';
    render(<SchemaBadge response={response('{"id":"x"}')} />);
    expect(screen.queryByTestId('schema-badge')).not.toBeInTheDocument();
  });

  it('does not validate an empty body: neutral skipped badge, no server call', async () => {
    schemas = [mk('a', 'User')];
    activeItem = item([{ schemaId: 'a', match: '2xx' }]);
    render(<SchemaBadge response={response('  ', 204)} />);
    expect(await screen.findByTestId('schema-badge')).toHaveTextContent('skipped (empty body)');
    expect(validateSchema).not.toHaveBeenCalled();
  });
});
