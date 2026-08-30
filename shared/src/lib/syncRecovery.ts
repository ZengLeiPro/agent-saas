import type { ChatQueueState } from './chatQueue';
import { createChatQueueState, reduceChatQueueEvent } from './chatQueue';
import { chatQueueReducerEventsFromWsEvent } from './chatQueueWs';
import type { WsAskUserQuestion, WsEvent } from '../types/ws';
import { mergeRunLiveness, type RunLiveness } from './runLiveness';

export type SyncRecoveryPhase = 'idle' | 'syncing' | 'ready' | 'full_refresh';

export interface SyncRequest {
  /** Stable while the same gap is outstanding, so an adapter sends it at most once. */
  id: number;
  lastSeq: number;
  epoch?: string;
  reason: 'pong' | 'gap' | 'epoch_change' | 'incomplete_sync';
}

export interface FullRefreshRequired {
  reason: 'overflow';
  authoritativeSeq: number;
  epoch?: string;
}

export interface SyncRuntimeProjection {
  sessionId: string;
  runId?: string;
  streamId?: string;
  status: Extract<WsEvent, { type: 'session_status' }>['status'] | 'active';
  liveness?: RunLiveness;
  terminal: boolean;
}

export interface SyncInteractionProjection {
  interactionId: string;
  type: string;
  sessionId?: string;
  questions?: WsAskUserQuestion[];
  toolId?: string;
  toolName?: string;
  displayName?: string;
  toolInput?: Record<string, unknown>;
  planContent?: string;
}

export interface SyncSessionProjection {
  sessionId: string;
  deleted: boolean;
  title?: string;
  preview?: string;
  updatedAtMs?: number;
  status?: Extract<WsEvent, { type: 'session_status' }>['status'];
  hasUnreadAiReply?: boolean;
}

export interface AppliedSyncEvent {
  seq: number;
  event: WsEvent;
}

export interface SyncRecoveryState {
  lastSeq: number;
  serverEpoch: string | null;
  phase: SyncRecoveryPhase;
  fullRefresh: FullRefreshRequired | null;
  syncRequest: SyncRequest | null;
  nextSyncRequestId: number;
  /** Epochs superseded in this process; frames from them are old-server responses. */
  retiredEpochs: ReadonlySet<string>;
  queueBySession: Readonly<Record<string, ChatQueueState>>;
  runtimeBySession: Readonly<Record<string, SyncRuntimeProjection>>;
  interactions: Readonly<Record<string, SyncInteractionProjection>>;
  resolvedInteractionIds: ReadonlySet<string>;
  sessions: Readonly<Record<string, SyncSessionProjection>>;
  /** Only events accepted by the latest reducer call; adapters may project these once. */
  appliedEvents: readonly AppliedSyncEvent[];
}

export interface SyncEventEnvelope {
  seq: number;
  epoch?: string;
  event: WsEvent;
}

export type SyncRecoveryAction =
  | { type: 'event'; envelope: SyncEventEnvelope }
  | { type: 'pong'; seq?: number; epoch?: string }
  | { type: 'sync_ok'; seq: number; epoch?: string; events: readonly { seq: number; event: WsEvent }[] }
  | { type: 'sync_overflow'; seq: number; epoch?: string }
  | { type: 'full_refresh_complete' }
  | { type: 'reset'; lastSeq?: number; serverEpoch?: string | null };

const TERMINAL_RUNTIME_STATUSES = new Set<SyncRuntimeProjection['status']>([
  'completed', 'failed', 'cancelled', 'orphaned',
]);

export function createSyncRecoveryState(
  baseline: { lastSeq?: number; serverEpoch?: string | null } = {},
): SyncRecoveryState {
  return {
    lastSeq: Math.max(0, baseline.lastSeq ?? 0),
    serverEpoch: baseline.serverEpoch ?? null,
    phase: 'idle',
    fullRefresh: null,
    syncRequest: null,
    nextSyncRequestId: 1,
    retiredEpochs: new Set(),
    queueBySession: {},
    runtimeBySession: {},
    interactions: {},
    resolvedInteractionIds: new Set(),
    sessions: {},
    appliedEvents: [],
  };
}

/** Public reset entry point for M20-04 account/session lifecycle wiring. */
export function resetSyncRecovery(
  baseline: { lastSeq?: number; serverEpoch?: string | null } = {},
): SyncRecoveryState {
  return createSyncRecoveryState(baseline);
}

function withoutApplied(state: SyncRecoveryState): SyncRecoveryState {
  return state.appliedEvents.length === 0 ? state : { ...state, appliedEvents: [] };
}

function clearedProjections(state: SyncRecoveryState): SyncRecoveryState {
  return {
    ...state,
    queueBySession: {},
    runtimeBySession: {},
    interactions: {},
    resolvedInteractionIds: new Set(),
    sessions: {},
    appliedEvents: [],
  };
}

function requestSync(
  state: SyncRecoveryState,
  reason: SyncRequest['reason'],
): SyncRecoveryState {
  if (state.phase === 'full_refresh') return state;
  const wanted = { lastSeq: state.lastSeq, epoch: state.serverEpoch ?? undefined };
  if (
    state.syncRequest
    && state.syncRequest.lastSeq === wanted.lastSeq
    && state.syncRequest.epoch === wanted.epoch
  ) {
    return state.phase === 'syncing' ? state : { ...state, phase: 'syncing' };
  }
  return {
    ...state,
    phase: 'syncing',
    syncRequest: {
      id: state.nextSyncRequestId,
      ...wanted,
      reason,
    },
    nextSyncRequestId: state.nextSyncRequestId + 1,
  };
}

function adoptEpoch(
  state: SyncRecoveryState,
  epoch: string | undefined,
): { state: SyncRecoveryState; oldServer: boolean; changed: boolean } {
  if (!epoch || epoch === state.serverEpoch) return { state, oldServer: false, changed: false };
  if (state.retiredEpochs.has(epoch)) return { state, oldServer: true, changed: false };

  const retiredEpochs = new Set(state.retiredEpochs);
  if (state.serverEpoch) retiredEpochs.add(state.serverEpoch);
  const next = clearedProjections({
    ...state,
    lastSeq: 0,
    serverEpoch: epoch,
    retiredEpochs,
    fullRefresh: null,
    syncRequest: null,
  });
  return { state: next, oldServer: false, changed: true };
}

function runtimeProjection(
  current: SyncRuntimeProjection | undefined,
  event: Extract<WsEvent, { type: 'session_status' }>,
): SyncRuntimeProjection {
  if (
    current?.terminal
    && (!event.runId || event.runId === current.runId)
    && !TERMINAL_RUNTIME_STATUSES.has(event.status)
  ) return current;
  return {
    sessionId: event.sessionId,
    ...(event.runId ? { runId: event.runId } : current?.runId ? { runId: current.runId } : {}),
    ...(event.streamId ? { streamId: event.streamId } : current?.streamId ? { streamId: current.streamId } : {}),
    status: event.status,
    ...(event.liveness !== undefined || current?.liveness !== undefined
      ? { liveness: mergeRunLiveness(current?.liveness, event.liveness) }
      : {}),
    terminal: TERMINAL_RUNTIME_STATUSES.has(event.status),
  };
}

function projectEvent(state: SyncRecoveryState, applied: AppliedSyncEvent): SyncRecoveryState {
  const event = applied.event;
  let next = state;

  const queueEvents = chatQueueReducerEventsFromWsEvent(event);
  for (const queueEvent of queueEvents) {
    const sessionId = queueEvent.type === 'snapshot' ? queueEvent.snapshot.sessionId
      : 'sessionId' in queueEvent ? queueEvent.sessionId
        : queueEvent.type === 'server_upsert' ? queueEvent.item.sessionId
          : undefined;
    if (!sessionId) continue;
    const current = next.queueBySession[sessionId] ?? createChatQueueState(sessionId);
    const reduced = reduceChatQueueEvent(current, queueEvent);
    if (reduced !== current) next = { ...next, queueBySession: { ...next.queueBySession, [sessionId]: reduced } };
  }

  if (event.type === 'session_status') {
    const current = next.runtimeBySession[event.sessionId];
    const runtime = runtimeProjection(current, event);
    const session = next.sessions[event.sessionId];
    next = {
      ...next,
      runtimeBySession: { ...next.runtimeBySession, [event.sessionId]: runtime },
      sessions: {
        ...next.sessions,
        [event.sessionId]: session?.deleted ? session : {
          ...(session ?? { sessionId: event.sessionId, deleted: false }),
          status: event.status,
        },
      },
    };
  } else if (event.type === 'stream_started' || event.type === 'active_stream') {
    if (event.type === 'stream_started' || event.active) {
      next = {
        ...next,
        runtimeBySession: {
          ...next.runtimeBySession,
          [event.sessionId]: {
            sessionId: event.sessionId,
            ...(event.runId ? { runId: event.runId } : {}),
            ...(event.streamId ? { streamId: event.streamId } : {}),
            status: 'active',
            ...(event.type === 'active_stream' && (event.liveness !== undefined || next.runtimeBySession[event.sessionId]?.liveness !== undefined)
              ? { liveness: mergeRunLiveness(next.runtimeBySession[event.sessionId]?.liveness, event.liveness) }
              : {}),
            terminal: false,
          },
        },
      };
    }
  }

  if (event.type === 'permission_request' || event.type === 'ask_user') {
    if (!next.resolvedInteractionIds.has(event.interactionId)) {
      next = {
        ...next,
        interactions: {
          ...next.interactions,
          [event.interactionId]: event.type === 'ask_user' ? {
            interactionId: event.interactionId,
            type: event.type,
            questions: event.questions,
          } : {
            interactionId: event.interactionId,
            type: event.type,
            toolId: event.toolId,
            toolName: event.toolName,
            displayName: event.displayName,
            toolInput: event.toolInput,
            planContent: event.planContent,
          },
        },
      };
    }
  } else if (event.type === 'pending_interactions') {
    const interactions: Record<string, SyncInteractionProjection> = {};
    for (const interaction of event.interactions) {
      if (!next.resolvedInteractionIds.has(interaction.interactionId)) {
        interactions[interaction.interactionId] = { ...interaction };
      }
    }
    next = { ...next, interactions };
  } else if (event.type === 'interaction_resolved') {
    const interactions = { ...next.interactions };
    delete interactions[event.interactionId];
    const resolvedInteractionIds = new Set(next.resolvedInteractionIds).add(event.interactionId);
    next = { ...next, interactions, resolvedInteractionIds };
  }

  if (event.type === 'session_updated') {
    const current = next.sessions[event.sessionId];
    if (!current?.deleted) {
      next = {
        ...next,
        sessions: {
          ...next.sessions,
          [event.sessionId]: {
            ...(current ?? { sessionId: event.sessionId, deleted: false }),
            ...(event.title !== undefined ? { title: event.title } : {}),
            ...(event.preview !== undefined ? { preview: event.preview } : {}),
            updatedAtMs: event.updatedAtMs,
          },
        },
      };
    }
  } else if (event.type === 'title_updated') {
    const current = next.sessions[event.sessionId];
    if (!current?.deleted) {
      next = {
        ...next,
        sessions: {
          ...next.sessions,
          [event.sessionId]: { ...(current ?? { sessionId: event.sessionId, deleted: false }), title: event.title },
        },
      };
    }
  } else if (event.type === 'session_read_state_changed') {
    const current = next.sessions[event.sessionId];
    if (!current?.deleted) {
      next = {
        ...next,
        sessions: {
          ...next.sessions,
          [event.sessionId]: {
            ...(current ?? { sessionId: event.sessionId, deleted: false }),
            hasUnreadAiReply: event.hasUnreadAiReply,
          },
        },
      };
    }
  } else if (event.type === 'session_deleted') {
    next = {
      ...next,
      sessions: {
        ...next.sessions,
        [event.sessionId]: { sessionId: event.sessionId, deleted: true },
      },
    };
  }

  return { ...next, appliedEvents: [...next.appliedEvents, applied] };
}

function applyContiguous(
  state: SyncRecoveryState,
  events: readonly AppliedSyncEvent[],
): SyncRecoveryState {
  let next = state;
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  for (const candidate of sorted) {
    if (!Number.isInteger(candidate.seq) || candidate.seq <= next.lastSeq) continue;
    if (candidate.seq !== next.lastSeq + 1) break;
    next = projectEvent(next, candidate);
    next = { ...next, lastSeq: candidate.seq };
  }
  return next;
}

export function reduceSyncRecovery(
  inputState: SyncRecoveryState,
  action: SyncRecoveryAction,
): SyncRecoveryState {
  if (action.type === 'reset') {
    return resetSyncRecovery({ lastSeq: action.lastSeq, serverEpoch: action.serverEpoch });
  }
  if (action.type === 'full_refresh_complete') {
    if (inputState.phase !== 'full_refresh') return withoutApplied(inputState);
    return { ...inputState, phase: 'ready', fullRefresh: null, syncRequest: null, appliedEvents: [] };
  }

  let state = withoutApplied(inputState);
  const actionEpoch = action.type === 'event' ? action.envelope.epoch : action.epoch;
  const epoch = adoptEpoch(state, actionEpoch);
  if (epoch.oldServer) return state;
  state = epoch.state;

  if (action.type === 'pong') {
    if (epoch.changed) return requestSync(state, 'epoch_change');
    if (typeof action.seq === 'number' && action.seq > state.lastSeq) return requestSync(state, 'pong');
    return state;
  }

  if (action.type === 'sync_overflow') {
    return clearedProjections({
      ...state,
      lastSeq: Math.max(0, action.seq),
      phase: 'full_refresh',
      syncRequest: null,
      fullRefresh: {
        reason: 'overflow',
        authoritativeSeq: Math.max(0, action.seq),
        ...(state.serverEpoch ? { epoch: state.serverEpoch } : {}),
      },
    });
  }

  if (action.type === 'event') {
    if (action.envelope.seq <= state.lastSeq) return state;
    if (action.envelope.seq !== state.lastSeq + 1) return requestSync(state, epoch.changed ? 'epoch_change' : 'gap');
    const next = applyContiguous(state, [{ seq: action.envelope.seq, event: action.envelope.event }]);
    return {
      ...next,
      phase: state.phase === 'syncing' ? 'syncing' : 'ready',
      syncRequest: state.phase === 'syncing' ? state.syncRequest : null,
    };
  }

  const beforeSeq = state.lastSeq;
  // Initial handshake may legitimately contain no user-scoped events even when the server's
  // cursor is non-zero (N-1/filtering compatibility). Empty responses to outstanding gaps do not advance.
  if (state.phase === 'idle' && beforeSeq === 0 && action.events.length === 0) {
    return {
      ...state,
      lastSeq: Math.max(0, action.seq),
      phase: 'ready',
      syncRequest: null,
      fullRefresh: null,
    };
  }
  const next = applyContiguous(state, action.events);
  if (next.lastSeq === action.seq) {
    return { ...next, phase: 'ready', syncRequest: null, fullRefresh: null };
  }
  if (next.lastSeq > beforeSeq) return requestSync(next, 'incomplete_sync');
  return requestSync(next, epoch.changed ? 'epoch_change' : 'gap');
}

export const syncRecoveryReducer = reduceSyncRecovery;

export function selectSyncRequest(state: SyncRecoveryState): SyncRequest | null {
  return state.syncRequest;
}

export function selectFullRefreshRequired(state: SyncRecoveryState): FullRefreshRequired | null {
  return state.fullRefresh;
}

export function selectRecoveredQueue(state: SyncRecoveryState, sessionId: string): ChatQueueState {
  return state.queueBySession[sessionId] ?? createChatQueueState(sessionId);
}

export function selectRecoveredRuntime(
  state: SyncRecoveryState,
  sessionId: string,
): SyncRuntimeProjection | undefined {
  return state.runtimeBySession[sessionId];
}

export function selectRecoveredInteractions(state: SyncRecoveryState): SyncInteractionProjection[] {
  return Object.values(state.interactions);
}

export function selectRecoveredSession(
  state: SyncRecoveryState,
  sessionId: string,
): SyncSessionProjection | undefined {
  return state.sessions[sessionId];
}

export function selectAppliedQueueEvents(state: SyncRecoveryState): AppliedSyncEvent[] {
  return state.appliedEvents.filter(({ event }) => chatQueueReducerEventsFromWsEvent(event).length > 0);
}

export function selectAppliedRuntimeEvents(state: SyncRecoveryState): AppliedSyncEvent[] {
  return state.appliedEvents.filter(({ event }) => (
    event.type === 'session_status' || event.type === 'active_stream' || event.type === 'stream_started'
  ));
}

export function selectAppliedInteractionEvents(state: SyncRecoveryState): AppliedSyncEvent[] {
  return state.appliedEvents.filter(({ event }) => (
    event.type === 'permission_request' || event.type === 'ask_user'
    || event.type === 'pending_interactions' || event.type === 'interaction_resolved'
  ));
}

export function selectAppliedSessionUserEvents(state: SyncRecoveryState): AppliedSyncEvent[] {
  return state.appliedEvents.filter(({ event }) => (
    event.type === 'session' || event.type === 'session_updated' || event.type === 'title_updated'
    || event.type === 'session_deleted' || event.type === 'session_read_state_changed'
    || event.type === 'user_message'
  ));
}
