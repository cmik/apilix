import { useState } from 'react';
import type { MongoQueryResult } from '../types';
import { executeMongoDBQuery } from '../api';
import CollectionSelector from './CollectionSelector';
import MongoResultViewer from './MongoResultViewer';
import { useToast } from './Toast';

interface DatabaseQueryEditorProps {
  uri: string;
  database: string;
}

export default function DatabaseQueryEditor({ uri, database }: DatabaseQueryEditorProps) {
  const [selectedCollection, setSelectedCollection] = useState('');
  const [query, setQuery] = useState('{}');
  const [limit, setLimit] = useState('100');
  const [result, setResult] = useState<MongoQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const handleExecute = async () => {
    if (!selectedCollection) {
      toast.error('Please select a collection');
      return;
    }

    setLoading(true);
    try {
      const result = await executeMongoDBQuery(uri, database, selectedCollection, query, parseInt(limit, 10));
      setResult(result);
      if (result.success) {
        toast.success(`Query executed successfully. Found ${result.documentCount || 0} documents.`);
      } else {
        toast.error(`Query failed: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Execution error: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Query Builder */}
      <div className="flex flex-col gap-3 bg-slate-750 p-4 rounded border border-slate-700">
        <div className="grid grid-cols-2 gap-3">
          <CollectionSelector
            uri={uri}
            database={database}
            selectedCollection={selectedCollection}
            onCollectionChange={setSelectedCollection}
          />

          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400 font-medium">Limit</label>
            <input
              type="number"
              min="1"
              max="10000"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none"
              placeholder="100"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-400 font-medium">Query Filter (JSON)</label>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-20 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none font-mono resize-none"
            placeholder='{}'
          />
        </div>

        <button
          onClick={handleExecute}
          disabled={loading || !selectedCollection}
          className="w-full bg-orange-600 hover:bg-orange-700 disabled:bg-slate-700 disabled:cursor-not-allowed text-white text-xs font-medium py-2 rounded transition-colors"
        >
          {loading ? 'Executing...' : 'Execute Query'}
        </button>
      </div>

      {/* Results */}
      {result && (
        <div className="flex-1 overflow-hidden">
          <MongoResultViewer result={result} />
        </div>
      )}
    </div>
  );
}
