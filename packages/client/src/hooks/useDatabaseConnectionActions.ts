import { useCallback, useState } from 'react';
import { useApp } from '../store';
import type { DatabaseConnection } from '../types';
import { testDatabaseConnection, closeDatabasePool } from '../api';

export interface UseDatabaseConnectionActionsReturn {
  handleEdit: (conn: DatabaseConnection) => void;
  handleTest: (conn: DatabaseConnection) => Promise<void>;
  handleDelete: (conn: DatabaseConnection) => Promise<void>;
  handleSelect: (connId: string | null) => void;
  testingId: string | null;
  deletingId: string | null;
}

/**
 * Centralized hook for database connection actions.
 * Ensures consistent behavior across sidebar and panel.
 */
export function useDatabaseConnectionActions(
  onEdit: (conn: DatabaseConnection) => void
): UseDatabaseConnectionActionsReturn {
  const { state, dispatch, getEnvironmentVars } = useApp();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const runtimeVars = {
    ...state.globalVariables,
    ...getEnvironmentVars(),
  };

  const handleEdit = useCallback(
    (conn: DatabaseConnection) => {
      onEdit(conn);
    },
    [onEdit]
  );

  const handleTest = useCallback(
    async (conn: DatabaseConnection) => {
      setTestingId(conn._id);
      try {
        const result = await testDatabaseConnection(conn, runtimeVars);
        dispatch({
          type: 'SET_DATABASE_TEST_RESULT',
          payload: { databaseId: conn._id, status: result.ok ? 'success' : 'failed', error: result.error },
        });
      } catch (err: unknown) {
        dispatch({
          type: 'SET_DATABASE_TEST_RESULT',
          payload: { databaseId: conn._id, status: 'failed', error: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        setTestingId(null);
      }
    },
    [runtimeVars, dispatch]
  );

  const handleDelete = useCallback(
    async (conn: DatabaseConnection) => {
      setDeletingId(conn._id);
      try {
        await closeDatabasePool(conn._id);
        dispatch({ type: 'REMOVE_DATABASE', payload: conn._id });
      } catch (err: unknown) {
        console.error('Failed to close pool:', err instanceof Error ? err.message : String(err));
      } finally {
        setDeletingId(null);
      }
    },
    [dispatch]
  );

  const handleSelect = useCallback(
    (connId: string | null) => {
      dispatch({ type: 'SET_ACTIVE_DATABASE', payload: connId });
    },
    [dispatch]
  );

  return {
    handleEdit,
    handleTest,
    handleDelete,
    handleSelect,
    testingId,
    deletingId,
  };
}
