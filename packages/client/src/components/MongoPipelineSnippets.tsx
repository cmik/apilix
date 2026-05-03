import { useRef, useState, useEffect } from 'react';

// ─── Snippet definitions ──────────────────────────────────────────────────────

const PIPELINE_SNIPPETS: { label: string; operator: string; template: string }[] = [
  {
    label: '$match',
    operator: '$match',
    template: '{ "$match": { "field": "value" } }',
  },
  {
    label: '$group',
    operator: '$group',
    template: '{ "$group": { "_id": "$field", "count": { "$sum": 1 } } }',
  },
  {
    label: '$project',
    operator: '$project',
    template: '{ "$project": { "field": 1, "_id": 0 } }',
  },
  {
    label: '$sort',
    operator: '$sort',
    template: '{ "$sort": { "field": 1 } }',
  },
  {
    label: '$limit',
    operator: '$limit',
    template: '{ "$limit": 100 }',
  },
  {
    label: '$skip',
    operator: '$skip',
    template: '{ "$skip": 0 }',
  },
  {
    label: '$lookup',
    operator: '$lookup',
    template: '{ "$lookup": { "from": "otherCollection", "localField": "_id", "foreignField": "parentId", "as": "items" } }',
  },
  {
    label: '$unwind',
    operator: '$unwind',
    template: '{ "$unwind": { "path": "$items", "preserveNullAndEmptyArrays": true } }',
  },
  {
    label: '$addFields',
    operator: '$addFields',
    template: '{ "$addFields": { "computedField": { "$concat": ["$first", " ", "$last"] } } }',
  },
  {
    label: '$set',
    operator: '$set',
    template: '{ "$set": { "updatedAt": "$$NOW" } }',
  },
  {
    label: '$count',
    operator: '$count',
    template: '{ "$count": "total" }',
  },
  {
    label: '$facet',
    operator: '$facet',
    template: '{ "$facet": { "byStatus": [{ "$group": { "_id": "$status", "count": { "$sum": 1 } } }], "total": [{ "$count": "count" }] } }',
  },
  {
    label: '$bucket',
    operator: '$bucket',
    template: '{ "$bucket": { "groupBy": "$amount", "boundaries": [0, 100, 500, 1000], "default": "Other", "output": { "count": { "$sum": 1 } } } }',
  },
  {
    label: '$replaceRoot',
    operator: '$replaceRoot',
    template: '{ "$replaceRoot": { "newRoot": "$nested" } }',
  },
  {
    label: '$out',
    operator: '$out',
    template: '{ "$out": "outputCollection" }',
  },
  {
    label: '$merge',
    operator: '$merge',
    template: '{ "$merge": { "into": "targetCollection", "on": "_id", "whenMatched": "merge", "whenNotMatched": "insert" } }',
  },
  {
    label: '$sample',
    operator: '$sample',
    template: '{ "$sample": { "size": 10 } }',
  },
  {
    label: '$sortByCount',
    operator: '$sortByCount',
    template: '{ "$sortByCount": "$category" }',
  },
  {
    label: '$graphLookup',
    operator: '$graphLookup',
    template: '{ "$graphLookup": { "from": "employees", "startWith": "$managerId", "connectFromField": "managerId", "connectToField": "_id", "as": "reportingHierarchy" } }',
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface MongoPipelineSnippetsProps {
  onInsert: (stageJson: string) => void;
}

export default function MongoPipelineSnippets({ onInsert }: MongoPipelineSnippetsProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Insert pipeline stage"
        className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        Stage
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl w-52 py-1 max-h-72 overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500 border-b border-slate-700 mb-1">
            Pipeline Stages
          </div>
          {PIPELINE_SNIPPETS.map(s => (
            <button
              key={s.operator}
              type="button"
              onClick={() => {
                onInsert(s.template);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors font-mono"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
