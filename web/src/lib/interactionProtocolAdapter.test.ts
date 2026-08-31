import { describe, expect, it } from 'vitest';
import { createInteractionReducerState, reduceInteraction } from '@agent/shared';
import { asWebInteractionAck, webInteractionAckEvent, webInteractionRequest } from './interactionProtocolAdapter';

const identity = { sessionId: 's', interactionId: 'i', generation: 1, authEpoch: 2, version: 3 };
describe('M20-05 Web interaction adapter', () => {
  it('sends the explicit protocol and prevents duplicate UI transitions through shared reducer', () => {
    const request = webInteractionRequest(identity, { allow: true }, 'r');
    expect(request).toMatchObject({ sessionId: 's', interactionId: 'i', response: { allow: true }, requestId: 'r', version: 3, authEpoch: 2, generation: 1 });
    let state = reduceInteraction(createInteractionReducerState(1), { type: 'server_pending', ...identity });
    state = reduceInteraction(state, { type: 'submit', ...identity, requestId: 'r', response: { allow: true } });
    state = reduceInteraction(state, webInteractionAckEvent({ type: 'respond_ok', interactionId: 'i', requestId: 'r', version: 3, status: 'resolved' }, identity)!);
    expect(state.byKey['s\u0000i']?.phase).toBe('resolved');
  });

  it('ignores an ACK from an old interaction revision', () => {
    expect(webInteractionAckEvent({ type: 'respond_ok', interactionId: 'i', requestId: 'r', version: 2, status: 'resolved' }, identity)).toBeNull();
  });

  it('does not treat an N-1 tokenless ACK as authoritative success', () => {
    expect(asWebInteractionAck({ type: 'respond_ok', interactionId: 'i' })).toBeNull();
  });
});
