import { describe, expect, it } from 'vitest';
import {
  buildInteractionResponseRequest, canInteract, createInteractionReducerState,
  interactionKey, reduceInteraction, selectInteraction,
} from './interactionProtocol';

const identity = { sessionId: 's', interactionId: 'i', generation: 2 };
const pending = () => reduceInteraction(createInteractionReducerState(2), { type: 'server_pending', ...identity });

describe('M20-05 interaction reducer', () => {
  it('uses session + interaction as the stable key and fences identity generations', () => {
    let state = pending();
    state = reduceInteraction(state, { type: 'generation_reset', generation: 3 });
    state = reduceInteraction(state, { type: 'server_pending', ...identity });
    expect(state.byKey).toEqual({});
    expect(interactionKey('a', 'b')).not.toBe(interactionKey('ab', ''));
  });

  it('prevents double submit and ignores an ACK for another request', () => {
    let state = pending();
    state = reduceInteraction(state, { type: 'submit', ...identity, requestId: 'r1', response: { allow: true } });
    state = reduceInteraction(state, { type: 'submit', ...identity, requestId: 'r2', response: { allow: false } });
    state = reduceInteraction(state, { type: 'ack', ...identity, requestId: 'r2', status: 'resolved' });
    expect(selectInteraction(state, 's', 'i')).toMatchObject({ phase: 'submitting', requestId: 'r1', response: { allow: true } });
  });

  it('allows retry after ACK loss without locally fabricating success', () => {
    let state = pending();
    state = reduceInteraction(state, { type: 'submit', ...identity, requestId: 'r1', response: { answers: { q: 'a' } } });
    state = reduceInteraction(state, { type: 'transport_failed', ...identity, requestId: 'r1', reason: 'ACK timeout' });
    expect(selectInteraction(state, 's', 'i')).toMatchObject({ phase: 'failed', retryable: true, serverAuthoritative: false });
    expect(canInteract(selectInteraction(state, 's', 'i'))).toBe(true);
  });

  it('does not revive resolved/denied/expired outcomes with stale pending frames', () => {
    for (const status of ['resolved', 'rejected', 'expired'] as const) {
      let state = pending();
      state = reduceInteraction(state, { type: 'outcome', ...identity, status, reason: 'visible reason' });
      state = reduceInteraction(state, { type: 'server_pending', ...identity });
      expect(selectInteraction(state, 's', 'i')).toMatchObject({ phase: status, reason: 'visible reason' });
    }
  });

  it('builds the explicit current protocol plus N-1 token alias', () => {
    expect(buildInteractionResponseRequest(identity, { allow: true }, 'req')).toEqual({
      action: 'respond', sessionId: 's', interactionId: 'i', response: { allow: true }, requestId: 'req', clientAttemptId: 'req',
    });
  });
});
