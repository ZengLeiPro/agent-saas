import {
  buildInteractionResponseRequest,
  type InteractionAck,
  type InteractionEvent,
  type InteractionIdentity,
  type InteractionResponseRequest,
  type WsEvent,
  type WsSyncSessionSnapshot,
} from '@agent/shared';

/** Web transport-only adapter; lifecycle decisions remain in the shared reducer. */
export function webInteractionRequest(identity: InteractionIdentity, response: Record<string, unknown>, requestId: string): InteractionResponseRequest {
  return buildInteractionResponseRequest(identity, response, requestId);
}

export function webInteractionAckEvent(event: Extract<WsEvent, { type: 'respond_ok' | 'respond_error' }>, identity: InteractionIdentity): InteractionEvent | null {
  const requestId = event.requestId ?? event.clientAttemptId ?? '';
  if ((event.version !== undefined && identity.version !== undefined && event.version !== identity.version)
    || (event.authEpoch !== undefined && identity.authEpoch !== undefined && event.authEpoch !== identity.authEpoch)
    || (event.generation !== undefined && event.generation !== identity.generation)) return null;
  if (event.type === 'respond_ok') {
    return { type: 'ack', ...identity, requestId, status: event.status ?? 'accepted', response: event.response };
  }
  return {
    type: 'ack', ...identity, requestId, status: event.status ?? 'rejected',
    reason: event.reason ?? event.error, retryable: event.retryable,
  };
}

export function webPendingInteractionsEvent(
  snapshot: WsSyncSessionSnapshot,
): Extract<WsEvent, { type: 'pending_interactions' }> {
  return {
    type: 'pending_interactions',
    sessionId: snapshot.sessionId,
    interactions: snapshot.pendingInteractions ?? [],
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
