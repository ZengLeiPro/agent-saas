export type InteractionPhase =
  | 'pending'
  | 'submitting'
  | 'accepted'
  | 'resolved'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type InteractionAckStatus =
  | 'accepted'
  | 'rejected'
  | 'duplicate'
  | 'resolved'
  | 'not_found'
  | 'expired';

export type InteractionResponse = Record<string, unknown>;

export interface InteractionIdentity {
  sessionId: string;
  interactionId: string;
  /** Authentication/session generation. Frames from another generation are ignored. */
  generation: number;
  /** Authentication epoch. Requests from a revoked epoch are rejected by the server. */
  authEpoch?: number;
  /** Monotonic server interaction revision. */
  version?: number;
}

export interface InteractionState extends InteractionIdentity {
  key: string;
  phase: InteractionPhase;
  response?: InteractionResponse;
  requestId?: string;
  reason?: string;
  retryable: boolean;
  serverAuthoritative: boolean;
}

export type InteractionEvent =
  | ({ type: 'server_pending' } & InteractionIdentity)
  | ({ type: 'submit'; requestId: string; response: InteractionResponse } & InteractionIdentity)
  | ({ type: 'ack'; requestId: string; status: InteractionAckStatus; response?: InteractionResponse; reason?: string; retryable?: boolean } & InteractionIdentity)
  | ({ type: 'outcome'; status: 'resolved' | 'rejected' | 'failed' | 'cancelled' | 'expired'; response?: InteractionResponse; reason?: string; retryable?: boolean } & InteractionIdentity)
  | ({ type: 'transport_failed'; requestId: string; reason: string } & InteractionIdentity)
  | { type: 'generation_reset'; generation: number };

export interface InteractionReducerState {
  generation: number;
  byKey: Readonly<Record<string, InteractionState>>;
}

export interface InteractionResponseRequest {
  action: 'respond';
  sessionId: string;
  interactionId: string;
  response: InteractionResponse;
  requestId: string;
  /** N-1 alias. New servers use requestId. */
  clientAttemptId: string;
  version: number;
  authEpoch: number;
  generation: number;
}

export interface InteractionAck {
  sessionId: string;
  interactionId: string;
  requestId: string;
  status: InteractionAckStatus;
  response?: InteractionResponse;
  reason?: string;
  retryable?: boolean;
}

export interface InteractionOutcome {
  sessionId: string;
  interactionId: string;
  status: 'resolved' | 'rejected' | 'failed' | 'expired';
  response?: InteractionResponse;
  reason?: string;
  retryable?: boolean;
}

export const interactionKey = (sessionId: string, interactionId: string): string => `${sessionId}\u0000${interactionId}`;

export function createInteractionReducerState(generation = 0): InteractionReducerState {
  return { generation, byKey: {} };
}

function terminal(phase: InteractionPhase): boolean {
  return phase === 'resolved' || phase === 'rejected' || phase === 'cancelled' || phase === 'expired';
}

export function reduceInteraction(state: InteractionReducerState, event: InteractionEvent): InteractionReducerState {
  if (event.type === 'generation_reset') {
    return event.generation === state.generation ? state : createInteractionReducerState(event.generation);
  }
  if (event.generation !== state.generation) return state;
  const key = interactionKey(event.sessionId, event.interactionId);
  const current = state.byKey[key];
  // Interaction revisions are monotonic. This also fences delayed ACK/outcome frames from an old card.
  if (current && event.version !== undefined && current.version !== undefined && event.version < current.version) return state;
  if (current && event.authEpoch !== undefined && current.authEpoch !== undefined && event.authEpoch !== current.authEpoch) return state;
  if (event.type === 'server_pending') {
    // An authoritative pending snapshot may recover a lost ACK, but must never revive a terminal outcome.
    if (current && terminal(current.phase)) return state;
    return put(state, key, {
      key, sessionId: event.sessionId, interactionId: event.interactionId, generation: event.generation,
      authEpoch: event.authEpoch, version: event.version,
      phase: 'pending', retryable: true, serverAuthoritative: true,
    });
  }
  if (event.type === 'submit') {
    if (current && !canInteract(current)) return state;
    return put(state, key, {
      key, sessionId: event.sessionId, interactionId: event.interactionId, generation: event.generation,
      authEpoch: event.authEpoch, version: event.version,
      phase: 'submitting', requestId: event.requestId, response: event.response,
      retryable: false, serverAuthoritative: false,
    });
  }
  if (!current) return state;
  if ('requestId' in event && current.requestId && event.requestId !== current.requestId) return state;
  if (event.type === 'transport_failed') {
    return put(state, key, { ...current, phase: 'pending', reason: event.reason, retryable: true, serverAuthoritative: false });
  }
  if (event.type === 'ack') {
    if (event.status === 'accepted' || event.status === 'duplicate') {
      return put(state, key, { ...current, phase: 'accepted', response: event.response ?? current.response, reason: event.reason, retryable: false, serverAuthoritative: true });
    }
    if (event.status === 'resolved') {
      return put(state, key, { ...current, phase: 'resolved', response: event.response ?? current.response, reason: event.reason, retryable: false, serverAuthoritative: true });
    }
    const phase: InteractionPhase = event.status === 'expired' ? 'expired' : event.status === 'not_found' ? 'failed' : 'rejected';
    return put(state, key, { ...current, phase, reason: event.reason, retryable: event.retryable ?? event.status === 'not_found', serverAuthoritative: true });
  }
  return put(state, key, {
    ...current, phase: event.status, response: event.response ?? current.response, reason: event.reason,
    retryable: event.retryable ?? event.status === 'failed', serverAuthoritative: true,
  });
}

function put(state: InteractionReducerState, key: string, value: InteractionState): InteractionReducerState {
  return { ...state, byKey: { ...state.byKey, [key]: value } };
}

export function selectInteraction(state: InteractionReducerState, sessionId: string, interactionId: string): InteractionState | undefined {
  return state.byKey[interactionKey(sessionId, interactionId)];
}

export function canInteract(state: InteractionState | undefined): boolean {
  return !state || state.phase === 'pending' || (state.phase === 'failed' && state.retryable);
}

export function isInteractionSubmitting(state: InteractionState | undefined): boolean {
  return state?.phase === 'submitting' || state?.phase === 'accepted';
}

export function createInteractionRequestId(sessionId: string, interactionId: string, response: InteractionResponse): string {
  const input = `${sessionId}\u0000${interactionId}\u0000${stableJson(response)}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ir_${(hash >>> 0).toString(36)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function buildInteractionResponseRequest(identity: InteractionIdentity, response: InteractionResponse, requestId: string): InteractionResponseRequest {
  return {
    action: 'respond', sessionId: identity.sessionId, interactionId: identity.interactionId,
    response, requestId, clientAttemptId: requestId,
    version: identity.version ?? 0, authEpoch: identity.authEpoch ?? 0, generation: identity.generation,
  };
}
