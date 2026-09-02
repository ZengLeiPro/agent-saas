import { describe, expect, it } from 'vitest';
import {
  createHistoryPagerState,
  inferHistorySemanticOrder,
  reduceHistoryPager,
  selectHistoryItems,
  type HistorySemanticItem,
} from './historyPager';

interface Item { id: string; body: string }
const item = (sequence: number, index = 0, id = `m-${sequence}-${index}`): HistorySemanticItem<Item> => ({
  semanticId: id,
  order: { sequence, eventIndex: index, stableId: id },
  value: { id, body: id },
});
const page = (items: HistorySemanticItem<Item>[], requestCursor: string | null, hasMore: boolean, revision = 'r1', generation = 1) => ({
  type: 'page' as const,
  page: { items, requestCursor, hasMore, historyRevision: revision, generation, ...(hasMore ? { nextCursor: `c-${items[0]?.semanticId}` } : {}) },
});

describe('shared history pager', () => {
  it('pages 500 records by 50 without duplicate or missing semantic ids', () => {
    let state = createHistoryPagerState<Item>(1);
    for (let end = 500; end > 0; end -= 50) {
      const values = Array.from({ length: 50 }, (_, offset) => item(end - 49 + offset));
      // Boundary retry/overlap is harmless.
      if (end < 500) values.push(item(end + 1));
      state = reduceHistoryPager(state, page(values, end === 500 ? null : `c-${end + 1}`, end > 50));
    }
    expect(selectHistoryItems(state)).toHaveLength(500);
    expect(new Set(selectHistoryItems(state).map((value) => value.id)).size).toBe(500);
    expect(selectHistoryItems(state).map((value) => value.id)).toEqual(
      Array.from({ length: 500 }, (_, index) => `m-${index + 1}-0`),
    );
  });

  it('keeps same-sequence collisions in event-index/stable-id order and dedupes retry', () => {
    let state = createHistoryPagerState<Item>(1);
    state = reduceHistoryPager(state, page([item(7, 1, 'b'), item(7, 0, 'a'), item(7, 1, 'b')], null, false));
    expect(selectHistoryItems(state).map((value) => value.id)).toEqual(['a', 'b']);
  });

  it('preserves insert while paging and fences old generation/revision pages', () => {
    let state = createHistoryPagerState<Item>(3);
    state = reduceHistoryPager(state, page([item(90), item(100)], null, true, 'r1', 3));
    state = reduceHistoryPager(state, { type: 'upsert', generation: 3, historyRevision: 'r1', item: item(110) });
    state = reduceHistoryPager(state, page([item(1)], 'old', false, 'r1', 2));
    state = reduceHistoryPager(state, page([item(40), item(50)], 'c-90', true, 'old-revision', 3));
    expect(selectHistoryItems(state).map((value) => value.id)).toEqual(['m-90-0', 'm-100-0', 'm-110-0']);
  });

  it('does not resurrect tombstones and replaces safely on compaction revision', () => {
    let state = createHistoryPagerState<Item>(1);
    state = reduceHistoryPager(state, page([item(1), item(2), item(3)], null, true));
    state = reduceHistoryPager(state, { type: 'tombstone', generation: 1, historyRevision: 'r1', semanticId: 'm-2-0' });
    state = reduceHistoryPager(state, page([item(1), item(2)], 'retry', false));
    expect(selectHistoryItems(state).map((value) => value.id)).toEqual(['m-1-0', 'm-3-0']);
    state = reduceHistoryPager(state, { type: 'compaction', generation: 1, historyRevision: 'r2', items: [item(3), item(4)], hasMore: false });
    expect(selectHistoryItems(state).map((value) => value.id)).toEqual(['m-3-0', 'm-4-0']);
  });

  it('parses canonical sequence/index and keeps unknown ids deterministic without timestamp guessing', () => {
    expect(inferHistorySemanticOrder('line-12-assistant-3')).toEqual({ sequence: 12, eventIndex: 3, stableId: 'line-12-assistant-3' });
    expect(inferHistorySemanticOrder('2026-01-01T00:00:00Z')).toBeUndefined();
    let state = createHistoryPagerState<Item>(1);
    state = reduceHistoryPager(state, page([
      { semanticId: 'unknown-b', value: { id: 'unknown-b', body: '' } },
      { semanticId: 'unknown-a', value: { id: 'unknown-a', body: '' } },
    ], null, false));
    expect(selectHistoryItems(state).map((value) => value.id)).toEqual(['unknown-b', 'unknown-a']);
  });
});
