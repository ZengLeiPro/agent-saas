import { describe, expect, it } from 'vitest';
import { createWebSessionMetadataState, reduceWebSessionMetadata } from './sessionMetadataAdapter';

describe('web M20-07 session list adapter', () => {
  it('uses cache only as seed and authoritative hydrate wins without stealing focus', () => {
    let state = createWebSessionMetadataState('tenant/user/1', [{ sessionId: 'a', updatedAtMs: 1 }, { sessionId: 'b', updatedAtMs: 2 }]);
    state = reduceWebSessionMetadata(state, { type: 'select', sessionId: 'b' });
    state = reduceWebSessionMetadata(state, { type: 'hydrate', authoritative: true, sessions: [{ sessionId: 'b', updatedAtMs: 3, serverVersion: 2, hasUnread: false }] });
    expect(state.order).toEqual(['b']);
    expect(state.selectedSessionId).toBe('b');
  });
});
