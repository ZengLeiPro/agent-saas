import {
  buildInteractionResponseRequest,
  type InteractionAck,
  type InteractionEvent,
  type InteractionIdentity,
  type InteractionResponseRequest,
  type WsEvent,
} from '@agent/shared';

/** Web transport-only adapter; lifecycle decisions remain in the shared reducer. */
export function webInteractionRequest(identity: InteractionIdentity, response: Record<string, unknown>, requestId: string): InteractionResponseRequest {
  return buildInteractionResponseRequest(identity, response, requestId);
}

export function webInteractionAckEvent(event: Extract<WsEvent, { type: 'respond_ok' | 'respond_error' }>, identity: InteractionIdentity): InteractionEvent {
  const requestId = event.requestId ?? event.clientAttemptId ?? '';
  if (event.type === 'respond_ok') {
    return { type: 'ack', ...identity, requestId, status: event.status ?? 'accepted', response: event.response };
  }
  return {
    type: 'ack', ...identity, requestId, status: event.status ?? 'rejected',
    reason: event.reason ?? event.error, retryable: event.retryable,
  };
}

export const asWebInteractionAck = (event: Extract<WsEvent, { type: 'respond_ok' | 'respond_error' }>): InteractionAck | null => {
  if (!event.sessionId || !(event.requestId ?? event.clientAttemptId)) return null; // N-1: wait for authoritative pending/resolved recovery.
  return {
    sessionId: event.sessionId, interactionId: event.interactionId,
    requestId: (event.requestId ?? event.clientAttemptId)!, status: event.status ?? (event.type === 'respond_ok' ? 'accepted' : 'rejected'),
    ...(event.type === 'respond_ok' && event.response ? { response: event.response } : {}),
    ...(event.type === 'respond_error' ? { reason: event.reason ?? event.error, retryable: event.retryable } : {}),
  };
};
