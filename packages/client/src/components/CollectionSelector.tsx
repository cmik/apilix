import { useEffect, useState } from 'react';
import type { MongoCollection } from '../types';
import { fetchMongoDBCollections } from '../api';
import { useToast } from './Toast';

interface CollectionSelectorProps {
  uri: string;
  database: string;
  selectedCollection: string;
  onCollectionChange: (collectionName: string) => void;
}

export default function CollectionSelector({
  uri,
  database,
  selectedCollection,
  onCollectionChange,
}: CollectionSelectorProps) {
  const [collections, setCollections] = useState<MongoCollection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!uri || !database) {
      setCollections([]);
      return;
    }

    const fetchCollections = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchMongoDBCollections(uri, database);
        if (result.error) {
          setError(result.error);
          toast.error(`Failed to load collections: ${result.error}`);
        } else {
          setCollections(result.collections);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        toast.error(`Failed to load collections: ${msg}`);
      } finally {
        setLoading(false);
      }
    };

    fetchCollections();
  }, [uri, database, toast]);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-slate-400 font-medium">Collection</label>
      {loading ? (
        <div className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-xs text-slate-400">
          Loading collections...
        </div>
      ) : error ? (
        <div className="px-3 py-2 bg-red-950/40 border border-red-800/50 rounded text-xs text-red-400">
          {error}
        </div>
      ) : collections.length === 0 ? (
        <div className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-xs text-slate-400">
          No collections found
        </div>
      ) : (
        <select
          value={selectedCollection}
          onChange={(e) => onCollectionChange(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none"
        >
          <option value="">— Select a collection —</option>
          {collections.map((col) => (
            <option key={col.name} value={col.name}>
              {col.name}
              {col.count ? ` (${col.count} docs)` : ''}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
