import type { BoundaryIdentity } from './identity';
import type { WsEvent } from '../types/ws';
import {
  createChatQueueState,
  reduceChatQueueEvent,
  selectChatQueueItems,
  type ChatQueueLocalIntent,
  type ChatQueueReducerEvent,
  type ChatQueueState,
} from './chatQueue';
import { chatQueueReducerEventsFromWsEvent } from './chatQueueWs';
import {
  createRunLivenessProjectionState,
  reduceRunLivenessProjection,
  type RunLivenessProjectionState,
} from './runLiveness';
import {
  createInteractionReducerState,
  reduceInteraction,
  type InteractionEvent,
  type InteractionReducerState,
} from './interactionProtocol';

/**
 * M40 client projection. This is the only cross-platform chat lifecycle reducer.
 *
 * The reducer deliberately owns no dispatch policy. A queue item can only be created or advanced by
 * a server event/snapshot; local intents are presentation-only until an ACK supplies a canonical item.
 */
export interface ChatClientState {
  generation: number;
  identityScope: string | null;
  selectedSessionId: string | null;
  queues: Readonly<Record<string, ChatQueueState>>;
  interactions: InteractionReducerState;
  liveness: RunLivenessProjectionState;
}

export type ChatClientAction =
  | { type: 'identity_boundary'; identity: BoundaryIdentity | null }
  | { type: 'epoch_boundary'; epoch: string | null; generation: number }
  | { type: 'select_session'; sessionId: string | null; generation: number }
  | { type: 'queue'; sessionId: string; event: ChatQueueReducerEvent; generation: number }
  | { type: 'ws'; event: WsEvent; fallbackSessionId?: string; generation: number }
  | { type: 'local_intent'; intent: ChatQueueLocalIntent; generation: number }
  | { type: 'local_intent_failed'; sessionId?: string; clientMsgId: string; reason: string; generation: number }
  | { type: 'local_intent_removed'; sessionId?: string; clientMsgId: string; generation: number }
  | { type: 'interaction'; event: InteractionEvent; generation: number }
  | { type: 'liveness'; sessionId: string; runId: string; liveness?: unknown; epoch?: string | null; generation: number };

const scopeOf = (identity: BoundaryIdentity | null): string | null => identity
  ? `${identity.userId}\u0000${identity.tenantId}\u0000${identity.generation}`
  : null;

export function createChatClientState(identity: BoundaryIdentity | null = null): ChatClientState {
  const generation = identity?.generation ?? 0;
  return {
    generation,
    identityScope: scopeOf(identity),
    selectedSessionId: null,
    queues: {},
    interactions: createInteractionReducerState(generation),
    liveness: createRunLivenessProjectionState(generation),
  };
}

function queueSessionFromWs(event: WsEvent, fallback?: string): string | undefined {
  if (event.type === 'queue_snapshot') return event.snapshot.sessionId;
  if (event.type === 'queue_item_updated') return event.item.sessionId;
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId;
  return fallback;
}

function applyQueue(state: ChatClientState, sessionId: string, event: ChatQueueReducerEvent): ChatClientState {
  const current = state.queues[sessionId] ?? createChatQueueState(sessionId);
  const next = reduceChatQueueEvent(current, event);
  if (next === current) return state;
  let liveness = state.liveness;
  for (const item of selectChatQueueItems(next)) {
    liveness = reduceRunLivenessProjection(liveness, {
      type: 'observe', generation: state.generation, sessionId,
      runId: item.runId, liveness: item.liveness,
    });
  }
  return { ...state, queues: { ...state.queues, [sessionId]: next }, liveness };
}

function findIntentSession(state: ChatClientState, clientMsgId: string, preferred?: string): string | undefined {
  if (preferred && state.queues[preferred]?.localIntents[clientMsgId]) return preferred;
  return Object.keys(state.queues).find((sessionId) => state.queues[sessionId].localIntents[clientMsgId]);
}

export function reduceChatClientState(state: ChatClientState, action: ChatClientAction): ChatClientState {
  if (action.type === 'identity_boundary') {
    const identityScope = scopeOf(action.identity);
    if (identityScope === state.identityScope) return state;
    return createChatClientState(action.identity);
  }
  if (action.generation !== state.generation) return state;

  switch (action.type) {
    case 'epoch_boundary':
      return {
        ...state,
        liveness: reduceRunLivenessProjection(state.liveness, {
          type: 'epoch_boundary', generation: action.generation, epoch: action.epoch,
        }),
      };
    case 'select_session':
      return action.sessionId === state.selectedSessionId ? state : { ...state, selectedSessionId: action.sessionId };
    case 'queue':
      return applyQueue(state, action.sessionId, action.event);
    case 'ws': {
      const sessionId = queueSessionFromWs(action.event, action.fallbackSessionId);
      if (!sessionId) return state;
      let next = state;
      if ((action.event.type === 'active_stream' || action.event.type === 'session_status')
        && action.event.runId) {
        next = {
          ...next,
          liveness: reduceRunLivenessProjection(next.liveness, {
            type: 'observe', generation: action.generation, sessionId,
            runId: action.event.runId, liveness: action.event.liveness,
          }),
        };
      }
      for (const event of chatQueueReducerEventsFromWsEvent(action.event, action.fallbackSessionId)) {
        next = applyQueue(next, sessionId, event);
      }
      return next;
    }
    case 'local_intent': {
      const sessionId = action.intent.sessionId ?? state.selectedSessionId;
      if (!sessionId) return state;
      return applyQueue(state, sessionId, { type: 'intent_added', intent: { ...action.intent, sessionId } });
    }
    case 'local_intent_failed': {
      const sessionId = findIntentSession(state, action.clientMsgId, action.sessionId);
      return sessionId ? applyQueue(state, sessionId, { type: 'intent_updated', clientMsgId: action.clientMsgId, state: 'failed', reason: action.reason }) : state;
    }
    case 'local_intent_removed': {
      const sessionId = findIntentSession(state, action.clientMsgId, action.sessionId);
      return sessionId ? applyQueue(state, sessionId, { type: 'intent_removed', clientMsgId: action.clientMsgId }) : state;
    }
    case 'interaction':
      return { ...state, interactions: reduceInteraction(state.interactions, action.event) };
    case 'liveness':
      return {
        ...state,
        liveness: reduceRunLivenessProjection(state.liveness, {
          type: 'observe', generation: action.generation, sessionId: action.sessionId,
          runId: action.runId, liveness: action.liveness, ...(action.epoch !== undefined ? { epoch: action.epoch } : {}),
        }),
      };
  }
}

export const chatClientReducer = reduceChatClientState;

export function selectChatClientQueue(state: ChatClientState, sessionId: string | null | undefined): ChatQueueState {
  return sessionId ? state.queues[sessionId] ?? createChatQueueState(sessionId) : createChatQueueState();
}

export function selectChatClientQueueItems(state: ChatClientState, sessionId: string | null | undefined) {
  return selectChatQueueItems(selectChatClientQueue(state, sessionId));
}

export function selectChatClientRunLiveness(
  state: ChatClientState,
  sessionId: string,
  runId: string,
) {
  return state.liveness.bySession[sessionId]?.[runId];
}

export function captureChatClientFence(state: ChatClientState, sessionId?: string | null): {
  generation: number;
  identityScope: string | null;
  sessionId: string | null;
} {
  return { generation: state.generation, identityScope: state.identityScope, sessionId: sessionId ?? state.selectedSessionId };
}

/** HTTP/upload/recovery callbacks must pass this fence before mutating any chat projection. */
export function isChatClientFenceCurrent(
  state: ChatClientState,
  fence: ReturnType<typeof captureChatClientFence>,
  options: { requireSelectedSession?: boolean } = {},
): boolean {
  return state.generation === fence.generation
    && state.identityScope === fence.identityScope
    && (!options.requireSelectedSession || state.selectedSessionId === fence.sessionId);
}

export interface ChatSendGate {
  online: boolean;
  locallyUnlocked: boolean;
  uploading?: boolean;
}

/** Fail-closed transport gate shared by Web and Mobile adapters. */
export function canSendChatIntent(gate: ChatSendGate): boolean {
  return gate.online && gate.locallyUnlocked && !gate.uploading;
}
