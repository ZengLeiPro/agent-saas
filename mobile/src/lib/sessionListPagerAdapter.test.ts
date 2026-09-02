import { expect, it } from 'vitest';
import { beginSessionListRefresh, createSessionListPagerState, mergeSessionListPage, reduceSessionListInteraction, selectSessionListItems } from './sessionListPagerAdapter';

it('mobile M20-07 adapter has web/shared parity and pending pinning', () => {
  let state = beginSessionListRefresh(createSessionListPagerState());
  state = mergeSessionListPage(state, {
    generation: state.generation, requestCursor: null, hasMore: false,
    sessions: [{ sessionId: 'a', updatedAtMs: 2 }, { sessionId: 'b', updatedAtMs: 1 }],
  });
  state = reduceSessionListInteraction(state, {
    type: 'requested', sessionId: 'b', interaction: { interactionId: 'i', type: 'ask_user', version: 1 },
  });
  expect(selectSessionListItems(state).map((item) => item.sessionId)).toEqual(['b', 'a']);
  expect(state.order).toEqual(['a', 'b']);
});
