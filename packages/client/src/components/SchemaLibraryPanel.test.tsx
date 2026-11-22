// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ResponseSchema, AppCollection } from '../types';

const dispatch = vi.fn();
let schemas: ResponseSchema[] = [];
let collections: AppCollection[] = [];
let n = 0;

vi.mock('../store', () => ({
  generateId: () => `gen-${++n}`,
  useApp: () => ({ state: { responseSchemas: schemas, collections }, dispatch }),
}));
vi.mock('../api', () => ({ inferSchema: vi.fn(), validateSchema: vi.fn() }));

import SchemaLibraryPanel from './SchemaLibraryPanel';

const sch = (id: string, name: string, extra: Partial<ResponseSchema> = {}): ResponseSchema => ({ id, name, schema: { type: 'object', title: name }, version: 1, ...extra });

beforeEach(() => {
  n = 0;
  dispatch.mockClear();
  schemas = [sch('a', 'User', { version: 3, description: 'A user', history: [{ version: 2, schema: { type: 'string' }, updatedAt: '2026-01-02' }, { version: 1, schema: { type: 'number' }, updatedAt: '2026-01-01' }] }), sch('b', 'Pet'), sch('c', 'Order')];
  collections = [{
    _id: 'c1', info: { name: 'Shop', schema: '' }, item: [
      { id: 'r1', name: 'Get user', request: { method: 'GET', url: { raw: '/u' }, apilix: { schemaLinks: [{ schemaId: 'a', match: '200' }] } } },
    ],
  } as unknown as AppCollection];
});
afterEach(cleanup);

const rows = () => screen.getAllByTestId('library-row');

describe('SchemaLibraryPanel', () => {
  it('lists schemas sorted by name with usage counts and filters by search', () => {
    render(<SchemaLibraryPanel />);
    expect(rows().map(r => r.textContent)).toEqual([expect.stringContaining('Order'), expect.stringContaining('Pet'), expect.stringContaining('User')]);
    expect(within(rows()[2]).getByText('1 request')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search schemas'), { target: { value: 'pe' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search schemas'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No schema matches/)).toBeInTheDocument();
  });

  it('shows used-by requests and the version history; restoring dispatches an update', () => {
    render(<SchemaLibraryPanel />);
    fireEvent.click(rows()[2]);
    const used = screen.getAllByTestId('used-by-row');
    expect(used).toHaveLength(1);
    expect(used[0]).toHaveTextContent('Shop');
    expect(used[0]).toHaveTextContent('Get user');
    expect(screen.getAllByTestId('history-row')).toHaveLength(3); // current + 2 previous
    fireEvent.click(screen.getAllByText('Restore as new version')[0]);
    expect(dispatch).toHaveBeenCalledWith({ type: 'SCHEMA_UPDATE', payload: { id: 'a', patch: { schema: { type: 'string' } } } });
    fireEvent.click(within(used[0]).getByText('Open'));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'OPEN_TAB' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_VIEW', payload: 'request' });
  });

  it('renames with case-insensitive uniqueness', () => {
    render(<SchemaLibraryPanel />);
    fireEvent.click(rows()[2]);
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByLabelText('New schema name');
    fireEvent.change(input, { target: { value: 'pet' } });
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Customer' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SCHEMA_UPDATE', payload: { id: 'a', patch: { name: 'Customer' } } });
  });

  it('duplicates into a new schema with a unique name', () => {
    render(<SchemaLibraryPanel />);
    fireEvent.click(rows()[1]); // Pet
    fireEvent.click(screen.getByText('Duplicate'));
    const call = dispatch.mock.calls[0][0];
    expect(call.type).toBe('SCHEMA_ADD');
    expect(call.payload).toMatchObject({ id: 'gen-1', name: 'Pet copy', version: 1 });
  });

  it('asks for confirmation and lists the linked requests before deleting', () => {
    render(<SchemaLibraryPanel />);
    fireEvent.click(rows()[2]);
    fireEvent.click(screen.getByText('Delete', { selector: 'button.hover\\:\\!text-red-400, button' }));
    expect(screen.getByTestId('delete-usage')).toHaveTextContent('Shop / Get user (200)');
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByText('Delete schema').closest('div')!.parentElement!).getByText('Delete'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'SCHEMA_DELETE', payload: 'a' });
  });

  it('creates a schema through the editor', async () => {
    render(<SchemaLibraryPanel />);
    fireEvent.click(screen.getByText('+ New schema'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice' } });
    fireEvent.click(screen.getByText('Save'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'SCHEMA_ADD', payload: expect.objectContaining({ id: 'gen-1', name: 'Invoice', source: 'manual', version: 1 }) });
  });

  it('imports a schema file and reports the result', async () => {
    render(<SchemaLibraryPanel />);
    const file = new File([JSON.stringify({ schemas: [{ id: 'z', name: 'user', schema: { type: 'object' } }, { id: 'a', name: 'Dup', schema: { type: 'object' } }] })], 's.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('schema-import-input'), { target: { files: [file] } });
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    const action = dispatch.mock.calls[0][0];
    expect(action.type).toBe('SCHEMA_SET_ALL');
    expect(action.payload.map((s: ResponseSchema) => s.name)).toEqual(['User', 'Pet', 'Order', 'user (2)']);
    expect(await screen.findByRole('status')).toHaveTextContent('Imported 1 schema (1 renamed to keep names unique), 1 skipped');
  });

  it('rejects an invalid import file', async () => {
    render(<SchemaLibraryPanel />);
    fireEvent.change(screen.getByTestId('schema-import-input'), { target: { files: [new File(['nope'], 'x.json')] } });
    expect(await screen.findByRole('status')).toHaveTextContent('not valid JSON');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
