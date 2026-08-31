import { expect, it } from 'vitest';
import { beginSessionListRefresh, createSessionListPagerState, mergeSessionListPage, selectSessionListItems } from './sessionListPagerAdapter';

it('web M20-07 adapter preserves shared cursor semantics', () => {
  let state = beginSessionListRefresh(createSessionListPagerState());
  state = mergeSessionListPage(state, {
    generation: state.generation, requestCursor: null, hasMore: false,
    sessions: [{ sessionId: 'a', updatedAtMs: 1 }, { sessionId: 'b', updatedAtMs: 1 }],
  });
  expect(selectSessionListItems(state).map((item) => item.sessionId)).toEqual(['b', 'a']);
});
