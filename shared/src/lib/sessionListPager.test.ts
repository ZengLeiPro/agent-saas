import { describe, expect, it } from 'vitest';
import type { ApiSessionListItem } from '../types/session';
import {
  beginSessionListRefresh,
  compareSessionListItems,
  createSessionListPagerState,
  mergeSessionListPage,
  reduceSessionListInteraction,
  selectActiveInteraction,
  selectSessionListItems,
  tombstoneSessionListItem,
  upsertSessionListItem,
} from './sessionListPager';

const item = (index: number, updatedAtMs = 10_000 - index): ApiSessionListItem => ({
  sessionId: `s-${String(index).padStart(3, '0')}`,
  updatedAtMs,
});

describe('M20-07 session list cursor pager', () => {
  it('merges 200 sessions in four 50-item pages without duplicates or omissions, including retry', () => {
    let state = beginSessionListRefresh(createSessionListPagerState());
    const generation = state.generation;
    for (let page = 0; page < 4; page += 1) {
      const sessions = Array.from({ length: 50 }, (_, offset) => item(page * 50 + offset));
      const requestCursor = page === 0 ? null : `c${page}`;
      const nextCursor = page < 3 ? `c${page + 1}` : undefined;
      state = mergeSessionListPage(state, { generation, requestCursor, sessions, nextCursor, hasMore: page < 3 });
      if (page === 1) {
        state = mergeSessionListPage(state, { generation, requestCursor, sessions, nextCursor, hasMore: true });
      }
    }
    const ids = selectSessionListItems(state).map((session) => session.sessionId);
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect(ids).toEqual(Array.from({ length: 200 }, (_, index) => item(index).sessionId));
  });

  it('uses updatedAt DESC + id DESC for identical timestamps', () => {
    const sessions = [item(1, 100), item(3, 100), item(2, 100)].sort(compareSessionListItems);
    expect(sessions.map((session) => session.sessionId)).toEqual(['s-003', 's-002', 's-001']);
  });

  it('dedupes page overlap, applies insert/update reorder, and tombstones deletion against retries', () => {
    let state = beginSessionListRefresh(createSessionListPagerState());
    const generation = state.generation;
    state = mergeSessionListPage(state, { generation, requestCursor: null, sessions: [item(0, 300), item(1, 200)], nextCursor: 'c1', hasMore: true });
    state = mergeSessionListPage(state, { generation, requestCursor: 'c1', sessions: [item(1, 200), item(2, 100)], hasMore: false });
    state = upsertSessionListItem(state, item(9, 400));
    state = upsertSessionListItem(state, item(2, 500));
    state = tombstoneSessionListItem(state, item(1).sessionId);
    state = mergeSessionListPage(state, { generation, requestCursor: 'c1', sessions: [item(1, 600)], hasMore: false });
    expect(selectSessionListItems(state).map((session) => session.sessionId)).toEqual(['s-002', 's-009', 's-000']);
  });

  it('fences old-generation pages after refresh', () => {
    let state = beginSessionListRefresh(createSessionListPagerState());
    const oldGeneration = state.generation;
    state = mergeSessionListPage(state, { generation: oldGeneration, requestCursor: null, sessions: [item(1)], nextCursor: 'old', hasMore: true });
    state = beginSessionListRefresh(state);
    const refreshed = state;
    state = mergeSessionListPage(state, { generation: oldGeneration, requestCursor: 'old', sessions: [item(2)], hasMore: false });
    expect(state).toBe(refreshed);
  });
});

describe('M20-07 active interaction index', () => {
  it('pins pending sessions without changing canonical page order and updates request/ACK/resolved immediately', () => {
    let state = beginSessionListRefresh(createSessionListPagerState());
    state = mergeSessionListPage(state, {
      generation: state.generation, requestCursor: null,
      sessions: [item(1, 300), item(2, 200), item(3, 100)], hasMore: false,
    });
    const canonicalOrder = state.order;
    state = reduceSessionListInteraction(state, {
      type: 'requested', sessionId: 's-003',
      interaction: { interactionId: 'i-1', type: 'ask_user', version: 1 },
    });
    expect(selectActiveInteraction(state, 's-003')?.interactionId).toBe('i-1');
    expect(selectSessionListItems(state).map((session) => session.sessionId)).toEqual(['s-003', 's-001', 's-002']);
    expect(state.order).toBe(canonicalOrder);
    state = reduceSessionListInteraction(state, { type: 'ack', sessionId: 's-003', interactionId: 'i-1', status: 'accepted' });
    expect(selectActiveInteraction(state, 's-003')).toBeDefined();
    state = reduceSessionListInteraction(state, { type: 'resolved', sessionId: 's-003', interactionId: 'i-1' });
    expect(selectActiveInteraction(state, 's-003')).toBeUndefined();
    expect(selectSessionListItems(state).map((session) => session.sessionId)).toEqual(canonicalOrder);
  });

  it('ignores older request summaries and removes cancelled/terminal entries incrementally', () => {
    let state = createSessionListPagerState();
    state = reduceSessionListInteraction(state, { type: 'requested', sessionId: 's', interaction: { interactionId: 'new', type: 'permission_request', version: 2 } });
    const current = state;
    state = reduceSessionListInteraction(state, { type: 'requested', sessionId: 's', interaction: { interactionId: 'old', type: 'ask_user', version: 1 } });
    expect(state).toBe(current);
    state = reduceSessionListInteraction(state, { type: 'cancelled', sessionId: 's', interactionId: 'new' });
    expect(state.orderedPendingSessionIds).toEqual([]);
  });
});
