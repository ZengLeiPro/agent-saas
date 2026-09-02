import { describe, expect, it } from 'vitest';
import { createInteractionReducerState, reduceInteraction } from '@agent/shared';
import { mobileInteractionAckEvent, mobileInteractionRequest } from './interactionProtocolAdapter';

const identity = { sessionId: 's', interactionId: 'i', generation: 4 };
describe('M20-05 Mobile interaction adapter', () => {
  it('maps structured denial reason into the shared reducer', () => {
    expect(mobileInteractionRequest(identity, { allow: false }, 'r')).toMatchObject({ requestId: 'r', clientAttemptId: 'r' });
    let state = reduceInteraction(createInteractionReducerState(4), { type: 'server_pending', ...identity });
    state = reduceInteraction(state, { type: 'submit', ...identity, requestId: 'r', response: { allow: false } });
    const event = mobileInteractionAckEvent({ type: 'respond_error', interactionId: 'i', requestId: 'r', status: 'rejected', error: 'Workflow approval denied', reason: 'Workflow approval denied', retryable: false }, identity);
    expect(event).not.toBeNull();
    state = reduceInteraction(state, event!);
    expect(state.byKey['s\u0000i']).toMatchObject({ phase: 'rejected', reason: 'Workflow approval denied', retryable: false });
  });

  it('keeps N-1 tokenless ACK in recovery mode', () => {
    expect(mobileInteractionAckEvent({ type: 'respond_ok', interactionId: 'i' }, identity)).toBeNull();
  });
});
