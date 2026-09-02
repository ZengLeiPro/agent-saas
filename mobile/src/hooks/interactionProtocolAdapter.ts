import {
  buildInteractionResponseRequest,
  type InteractionEvent,
  type InteractionIdentity,
  type InteractionResponseRequest,
  type WsEvent,
} from '@agent/shared';

/** Mobile transport-only adapter; Shared owns lifecycle and stale-frame fences. */
export function mobileInteractionRequest(identity: InteractionIdentity, response: Record<string, unknown>, requestId: string): InteractionResponseRequest {
  return buildInteractionResponseRequest(identity, response, requestId);
}

export function mobileInteractionAckEvent(event: Extract<WsEvent, { type: 'respond_ok' | 'respond_error' }>, identity: InteractionIdentity): InteractionEvent | null {
  const requestId = event.requestId ?? event.clientAttemptId;
  if ((event.version !== undefined && identity.version !== undefined && event.version !== identity.version)
    || (event.authEpoch !== undefined && identity.authEpoch !== undefined && event.authEpoch !== identity.authEpoch)
    || (event.generation !== undefined && event.generation !== identity.generation)) return null;
  // N-1 ACK has no idempotency token: never turn it into local success; recovery is authoritative.
  if (!requestId) return null;
  return event.type === 'respond_ok'
    ? { type: 'ack', ...identity, requestId, status: event.status ?? 'accepted', response: event.response }
    : { type: 'ack', ...identity, requestId, status: event.status ?? 'rejected', reason: event.reason ?? event.error, retryable: event.retryable };
}
