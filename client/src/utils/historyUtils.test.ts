import { describe, it, expect } from 'vitest';
import type { HistoryRequest } from '../types';
import { formatDayLabel, groupByDay } from './historyUtils';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(id: string, ts: number): HistoryRequest {
  return {
    id,
    timestamp: ts,
    method: 'GET',
    url: 'https://example.com',
    collectionId: 'col1',
    itemId: 'item1',
    requestSnapshot: { id: 'item1', name: 'Test' } as HistoryRequest['requestSnapshot'],
    statusCode: 200,
    statusText: 'OK',
    responseTime: 100,
    error: null,
  };
}

/** Timestamp set to noon on `n` days ago so date comparisons are stable. */
function daysAgo(n: number): number {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

// ─── formatDayLabel ───────────────────────────────────────────────────────────

describe('formatDayLabel', () => {
  it('returns "Today" for a timestamp from today', () => {
    expect(formatDayLabel(Date.now())).toBe('Today');
  });

  it('returns "Today" for the very start of today (midnight)', () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(formatDayLabel(midnight.getTime())).toBe('Today');
  });

  it('returns "Yesterday" for a timestamp from yesterday', () => {
    expect(formatDayLabel(daysAgo(1))).toBe('Yesterday');
  });

  it('returns a locale date string for timestamps older than yesterday', () => {
    const old = new Date();
    old.setDate(old.getDate() - 7);
    old.setHours(12, 0, 0, 0);
    const expected = old.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    expect(formatDayLabel(old.getTime())).toBe(expected);
  });

  it('does not return "Today" or "Yesterday" for a timestamp 7 days ago', () => {
    const label = formatDayLabel(daysAgo(7));
    expect(label).not.toBe('Today');
    expect(label).not.toBe('Yesterday');
  });

  it('does not return "Yesterday" for a timestamp 2 days ago', () => {
    expect(formatDayLabel(daysAgo(2))).not.toBe('Yesterday');
  });
});

// ─── groupByDay ───────────────────────────────────────────────────────────────

describe('groupByDay', () => {
  it('returns an empty array for empty input', () => {
    expect(groupByDay([])).toEqual([]);
  });

  it('produces a single group when all entries are from today', () => {
    const ts = daysAgo(0);
    const entries = [makeEntry('a', ts), makeEntry('b', ts), makeEntry('c', ts)];
    const groups = groupByDay(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Today');
    expect(groups[0].entries.map(e => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('produces separate groups for today and yesterday', () => {
    const entries = [
      makeEntry('t1', daysAgo(0)),
      makeEntry('t2', daysAgo(0)),
      makeEntry('y1', daysAgo(1)),
    ];
    const groups = groupByDay(entries);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe('Today');
    expect(groups[0].entries.map(e => e.id)).toEqual(['t1', 't2']);
    expect(groups[1].label).toBe('Yesterday');
    expect(groups[1].entries.map(e => e.id)).toEqual(['y1']);
  });

  it('produces a group per distinct day across multiple days', () => {
    const entries = [
      makeEntry('d0', daysAgo(0)),
      makeEntry('d1', daysAgo(1)),
      makeEntry('d7', daysAgo(7)),
    ];
    const groups = groupByDay(entries);
    expect(groups).toHaveLength(3);
    expect(groups[0].label).toBe('Today');
    expect(groups[1].label).toBe('Yesterday');
    expect(groups[2].entries[0].id).toBe('d7');
  });

  it('does not merge non-consecutive same-day blocks', () => {
    // today, yesterday, today — interleaved, so 3 groups (no merging across gap)
    const entries = [
      makeEntry('t1', daysAgo(0)),
      makeEntry('y1', daysAgo(1)),
      makeEntry('t2', daysAgo(0)),
    ];
    const groups = groupByDay(entries);
    expect(groups).toHaveLength(3);
    expect(groups[0].label).toBe('Today');
    expect(groups[1].label).toBe('Yesterday');
    expect(groups[2].label).toBe('Today');
  });

  it('preserves entry order within each group', () => {
    const base = daysAgo(0);
    const entries = [
      makeEntry('first',  base - 5000),
      makeEntry('second', base - 4000),
      makeEntry('third',  base - 3000),
    ];
    const groups = groupByDay(entries);
    expect(groups[0].entries.map(e => e.id)).toEqual(['first', 'second', 'third']);
  });

  it('handles a single entry', () => {
    const groups = groupByDay([makeEntry('solo', daysAgo(0))]);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toHaveLength(1);
    expect(groups[0].entries[0].id).toBe('solo');
  });
});
