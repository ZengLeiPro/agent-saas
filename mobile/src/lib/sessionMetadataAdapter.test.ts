import { describe, expect, it } from 'vitest';
import { createMobileSessionMetadataState, reduceMobileSessionMetadata } from './sessionMetadataAdapter';

describe('mobile M20-07 session list adapter', () => {
  it('shares tombstone and deterministic selection semantics', () => {
    let state = createMobileSessionMetadataState('tenant/user/1', [{ sessionId: 'a', updatedAtMs: 2 }, { sessionId: 'b', updatedAtMs: 1 }]);
    state = reduceMobileSessionMetadata(state, { type: 'select', sessionId: 'a' });
    state = reduceMobileSessionMetadata(state, { type: 'delete', sessionId: 'a' });
    state = reduceMobileSessionMetadata(state, { type: 'metadata', session: { sessionId: 'a', title: 'late', updatedAtMs: 99 } });
    expect(state.selectedSessionId).toBe('b');
    expect(state.byId.a).toMatchObject({ deleted: true });
  });
});
