import type { MessageAttachmentDisplay } from '../types/message';
import { mergeRunLiveness, normalizeRunLiveness, type RunLiveness } from './runLiveness';

/** M20-02 wire/storage contract. This version is independent from the WS replay epoch (M20-03). */
export const CHAT_QUEUE_SNAPSHOT_VERSION = 1 as const;

export type ChatQueueDeliveryMode = 'queue' | 'steer';

/**
 * Server-authoritative lifecycle for one accepted user submission.
 *
 * `cancel_pending` is an optimistic request projection only. A later server state always settles it.
 * `steered` means the source run was durably absorbed by another run and is no longer independently
 * dispatchable. The source may later receive a terminal projection.
 */
export type ChatQueueStatus =
  | 'queued'
  | 'running'
  | 'steered'
  | 'cancel_pending'
  | 'cancelled'
  | 'completed'
  | 'failed';

export type ChatQueueTerminalStatus = Extract<
  ChatQueueStatus,
  'cancelled' | 'completed' | 'failed'
>;

export interface ChatQueueAttachment extends MessageAttachmentDisplay {
  /** Canonical submission/replay authority. Queue V1 never carries a path. */
  attachmentId: string;
}

/** One canonical server queue record. All three correlation keys remain stable for its lifetime. */
export interface ChatQueueItem {
  sessionId: string;
  clientMsgId: string;
  runId: string;
  sourceRunId: string;
  deliveryMode: ChatQueueDeliveryMode;
  status: ChatQueueStatus;
  queuePosition?: number;
  targetRunId?: string;
  content?: string;
  attachments?: ChatQueueAttachment[];
  acceptedAt?: string;
  updatedAt?: string;
  reason?: string;
  /** Server-owned; absent on N-1 snapshots and normalized to unknown by selectors. */
  liveness?: RunLiveness;
}

export interface ChatQueueSnapshot {
  version: typeof CHAT_QUEUE_SNAPSHOT_VERSION;
  sessionId: string;
  /** Server acceptance order. queuePosition is authoritative when present. */
  items: ChatQueueItem[];
  generatedAt: string;
}

/**
 * A device may retain an unconfirmed intent for presentation/retry only. It never participates in
 * dispatch ordering and is removed as soon as a server item with the same clientMsgId appears.
 */
export interface ChatQueueLocalIntent {
  sessionId?: string;
  clientMsgId: string;
  deliveryMode: ChatQueueDeliveryMode;
  content?: string;
  attachments?: ChatQueueAttachment[];
  state: 'sending' | 'verifying' | 'failed';
  createdAt: number;
  reason?: string;
}

export interface ChatQueueState {
  sessionId?: string;
  /** Canonical items keyed by clientMsgId. Use selectors for alias lookup and ordering. */
  items: Record<string, ChatQueueItem>;
  order: string[];
  localIntents: Record<string, ChatQueueLocalIntent>;
  hydrated: boolean;
  snapshotGeneratedAt?: string;
}

export type ChatQueueItemPatch = Partial<ChatQueueItem> &
  Pick<ChatQueueItem, 'sessionId' | 'status'> &
  ({ clientMsgId: string } | { runId: string } | { sourceRunId: string });

export type ChatQueueReducerEvent =
  | { type: 'snapshot'; snapshot: ChatQueueSnapshot }
  | { type: 'server_upsert'; item: ChatQueueItemPatch }
  | {
      type: 'server_terminal';
      sessionId: string;
      status: ChatQueueTerminalStatus;
      clientMsgId?: string;
      runId?: string;
      sourceRunId?: string;
      updatedAt?: string;
      reason?: string;
    }
  | {
      type: 'steered';
      sessionId: string;
      clientMsgIds: string[];
      sourceRunIds: string[];
      targetRunId?: string;
      updatedAt?: string;
    }
  | {
      type: 'cancel_requested';
      sessionId: string;
      clientMsgId?: string;
      runId?: string;
      sourceRunId?: string;
      updatedAt?: string;
    }
  | { type: 'intent_added'; intent: ChatQueueLocalIntent }
  | {
      type: 'intent_updated';
      clientMsgId: string;
      state: ChatQueueLocalIntent['state'];
      reason?: string;
    }
  | { type: 'intent_removed'; clientMsgId: string }
  | { type: 'reset'; sessionId?: string };

const TERMINAL = new Set<ChatQueueStatus>(['cancelled', 'completed', 'failed']);

const SERVER_PROGRESS_RANK: Record<Exclude<ChatQueueStatus, 'cancel_pending'>, number> = {
  queued: 0,
  running: 1,
  steered: 2,
  cancelled: 3,
  completed: 3,
  failed: 3,
};

export function isChatQueueTerminalStatus(
  status: ChatQueueStatus | undefined,
): status is ChatQueueTerminalStatus {
  return Boolean(status && TERMINAL.has(status));
}

export function createChatQueueState(sessionId?: string): ChatQueueState {
  return {
    ...(sessionId ? { sessionId } : {}),
    items: {},
    order: [],
    localIntents: {},
    hydrated: false,
  };
}

export function chatQueueItemKey(
  value: Pick<Partial<ChatQueueItem>, 'clientMsgId' | 'runId' | 'sourceRunId'>,
): string | undefined {
  return value.clientMsgId || value.runId || value.sourceRunId;
}

function findItemKey(state: ChatQueueState, patch: Partial<ChatQueueItem>): string | undefined {
  if (patch.clientMsgId && state.items[patch.clientMsgId]) return patch.clientMsgId;
  for (const key of state.order) {
    const item = state.items[key];
    if (!item) continue;
    if (
      (patch.clientMsgId && item.clientMsgId === patch.clientMsgId)
      || (patch.runId && item.runId === patch.runId)
      || (patch.sourceRunId && item.sourceRunId === patch.sourceRunId)
    ) return key;
  }
  return undefined;
}

function compareIso(left: string | undefined, right: string | undefined): number | undefined {
  if (!left || !right) return undefined;
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return a - b;
}

/**
 * Prevent duplicate/out-of-order live events from rolling an item backwards. Snapshot replacement is
 * handled separately and therefore remains the final authority after reconnect/cold start.
 */
function settleServerStatus(
  current: ChatQueueItem | undefined,
  incoming: ChatQueueStatus,
  incomingUpdatedAt?: string,
): ChatQueueStatus {
  if (!current) return incoming === 'cancel_pending' ? 'queued' : incoming;
  if (incoming === 'cancel_pending') {
    return current.status === 'queued' ? 'cancel_pending' : current.status;
  }
  if (current.status === 'cancel_pending') return incoming;

  const currentTerminal = isChatQueueTerminalStatus(current.status);
  const incomingTerminal = isChatQueueTerminalStatus(incoming);
  if (currentTerminal) {
    if (!incomingTerminal) return current.status;
    if (current.status === incoming) return current.status;
    // Conflicting terminal frames can only be ordered when both carry server time. Otherwise the
    // first observed terminal remains sticky until the next authoritative snapshot.
    return (compareIso(incomingUpdatedAt, current.updatedAt) ?? 0) > 0
      ? incoming
      : current.status;
  }
  if (incomingTerminal) return incoming;

  const currentRank = SERVER_PROGRESS_RANK[current.status];
  const incomingRank = SERVER_PROGRESS_RANK[incoming];
  return incomingRank >= currentRank ? incoming : current.status;
}

function canonicalizeItem(
  patch: ChatQueueItemPatch,
  current?: ChatQueueItem,
): ChatQueueItem | undefined {
  const clientMsgId = patch.clientMsgId ?? current?.clientMsgId;
  const runId = patch.runId ?? current?.runId ?? patch.sourceRunId;
  const sourceRunId = patch.sourceRunId ?? current?.sourceRunId ?? runId;
  if (!clientMsgId || !runId || !sourceRunId) return undefined;
  const status = settleServerStatus(current, patch.status, patch.updatedAt);
  return {
    ...(current ?? {} as ChatQueueItem),
    ...patch,
    clientMsgId,
    runId,
    sourceRunId,
    deliveryMode: patch.deliveryMode ?? current?.deliveryMode ?? 'queue',
    status,
    ...(patch.liveness !== undefined || current?.liveness !== undefined
      ? { liveness: mergeRunLiveness(current?.liveness, patch.liveness) }
      : {}),
    // A stale lower-progress event may carry an old reason/position. Preserve only safe identity and
    // missing payload fields while keeping the current lifecycle projection sticky.
    ...(status !== patch.status && current?.reason !== undefined ? { reason: current.reason } : {}),
    ...(status !== patch.status && current?.updatedAt ? { updatedAt: current.updatedAt } : {}),
  };
}

function withServerUpsert(state: ChatQueueState, patch: ChatQueueItemPatch): ChatQueueState {
  if (state.sessionId && patch.sessionId !== state.sessionId) return state;
  const existingKey = findItemKey(state, patch);
  const current = existingKey ? state.items[existingKey] : undefined;
  const item = canonicalizeItem(patch, current);
  if (!item) return state;
  const key = item.clientMsgId;
  const items = { ...state.items };
  if (existingKey && existingKey !== key) delete items[existingKey];
  items[key] = item;
  const order = existingKey
    ? state.order.map((candidate) => candidate === existingKey ? key : candidate)
    : [...state.order, key];
  const dedupedOrder = order.filter((candidate, index) => order.indexOf(candidate) === index);
  const localIntents = { ...state.localIntents };
  delete localIntents[key];
  return {
    ...state,
    sessionId: state.sessionId ?? item.sessionId,
    items,
    order: dedupedOrder,
    localIntents,
  };
}

function normalizeSnapshot(snapshot: ChatQueueSnapshot): ChatQueueSnapshot {
  const seenClientIds = new Set<string>();
  const seenRunIds = new Set<string>();
  const items: ChatQueueItem[] = [];
  for (const raw of snapshot.items) {
    if (raw.sessionId !== snapshot.sessionId) continue;
    if (!raw.clientMsgId || !raw.runId || !raw.sourceRunId) continue;
    if (seenClientIds.has(raw.clientMsgId) || seenRunIds.has(raw.runId)) continue;
    seenClientIds.add(raw.clientMsgId);
    seenRunIds.add(raw.runId);
    items.push({
      ...raw,
      deliveryMode: raw.deliveryMode === 'steer' ? 'steer' : 'queue',
      // cancel_pending is never a durable snapshot value.
      status: raw.status === 'cancel_pending' ? 'queued' : raw.status,
    });
  }
  return { ...snapshot, items };
}

export function hydrateChatQueueSnapshot(
  state: ChatQueueState,
  rawSnapshot: ChatQueueSnapshot,
): ChatQueueState {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const items: Record<string, ChatQueueItem> = {};
  const order: string[] = [];
  for (const item of snapshot.items) {
    const previous = state.items[item.clientMsgId];
    items[item.clientMsgId] = previous?.runId === item.runId
      ? { ...item, liveness: mergeRunLiveness(previous.liveness, item.liveness) }
      : item;
    order.push(item.clientMsgId);
  }
  const localIntents = Object.fromEntries(
    Object.entries(state.localIntents).filter(([clientMsgId, intent]) => (
      !items[clientMsgId]
      && (!intent.sessionId || intent.sessionId === snapshot.sessionId)
    )),
  );
  return {
    sessionId: snapshot.sessionId,
    items,
    order,
    localIntents,
    hydrated: true,
    snapshotGeneratedAt: snapshot.generatedAt,
  };
}

function patchByAliases(
  state: ChatQueueState,
  aliases: { clientMsgId?: string; runId?: string; sourceRunId?: string },
  patch: Pick<ChatQueueItemPatch, 'status'> & Partial<ChatQueueItemPatch>,
): ChatQueueState {
  const key = findItemKey(state, aliases);
  if (!key) return state;
  const current = state.items[key];
  return withServerUpsert(state, { ...current, ...patch, sessionId: current.sessionId });
}

export function reduceChatQueueEvent(
  state: ChatQueueState,
  event: ChatQueueReducerEvent,
): ChatQueueState {
  switch (event.type) {
    case 'snapshot':
      return hydrateChatQueueSnapshot(state, event.snapshot);
    case 'server_upsert':
      return withServerUpsert(state, event.item);
    case 'server_terminal':
      if (state.sessionId && event.sessionId !== state.sessionId) return state;
      return patchByAliases(state, event, {
        status: event.status,
        ...(event.updatedAt ? { updatedAt: event.updatedAt } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      });
    case 'steered': {
      if (state.sessionId && event.sessionId !== state.sessionId) return state;
      let next = state;
      const count = Math.max(event.clientMsgIds.length, event.sourceRunIds.length);
      for (let index = 0; index < count; index += 1) {
        next = patchByAliases(next, {
          clientMsgId: event.clientMsgIds[index],
          sourceRunId: event.sourceRunIds[index],
        }, {
          status: 'steered',
          ...(event.targetRunId ? { targetRunId: event.targetRunId } : {}),
          ...(event.updatedAt ? { updatedAt: event.updatedAt } : {}),
        });
      }
      return next;
    }
    case 'cancel_requested':
      if (state.sessionId && event.sessionId !== state.sessionId) return state;
      return patchByAliases(state, event, {
        status: 'cancel_pending',
        ...(event.updatedAt ? { updatedAt: event.updatedAt } : {}),
      });
    case 'intent_added':
      if (state.items[event.intent.clientMsgId]) return state;
      if (state.sessionId && event.intent.sessionId && event.intent.sessionId !== state.sessionId) return state;
      return {
        ...state,
        localIntents: {
          ...state.localIntents,
          [event.intent.clientMsgId]: event.intent,
        },
      };
    case 'intent_updated': {
      const current = state.localIntents[event.clientMsgId];
      if (!current) return state;
      return {
        ...state,
        localIntents: {
          ...state.localIntents,
          [event.clientMsgId]: {
            ...current,
            state: event.state,
            ...(event.reason ? { reason: event.reason } : {}),
          },
        },
      };
    }
    case 'intent_removed': {
      if (!state.localIntents[event.clientMsgId]) return state;
      const localIntents = { ...state.localIntents };
      delete localIntents[event.clientMsgId];
      return { ...state, localIntents };
    }
    case 'reset':
      return createChatQueueState(event.sessionId);
    default:
      return state;
  }
}

/** React/useReducer-compatible alias. */
export const chatQueueReducer = reduceChatQueueEvent;

export function selectChatQueueItem(
  state: ChatQueueState,
  aliases: { clientMsgId?: string; runId?: string; sourceRunId?: string },
): ChatQueueItem | undefined {
  const key = findItemKey(state, aliases);
  return key ? state.items[key] : undefined;
}

export function selectChatQueueItems(state: ChatQueueState): ChatQueueItem[] {
  return state.order
    .map((key) => state.items[key])
    .filter((item): item is ChatQueueItem => Boolean(item))
    .sort((left, right) => {
      const leftActive = !isChatQueueTerminalStatus(left.status) && left.status !== 'steered';
      const rightActive = !isChatQueueTerminalStatus(right.status) && right.status !== 'steered';
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (leftActive && rightActive) {
        const leftPosition = left.queuePosition ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.queuePosition ?? Number.MAX_SAFE_INTEGER;
        if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      }
      const accepted = Date.parse(left.acceptedAt ?? '') - Date.parse(right.acceptedAt ?? '');
      return Number.isFinite(accepted) && accepted !== 0 ? accepted : 0;
    });
}

export function selectPendingChatQueueItems(state: ChatQueueState): ChatQueueItem[] {
  return selectChatQueueItems(state).filter((item) => (
    item.status === 'queued' || item.status === 'cancel_pending'
  ));
}

export function selectCancellableChatQueueItems(state: ChatQueueState): ChatQueueItem[] {
  return selectChatQueueItems(state).filter((item) => item.status === 'queued');
}

export function selectRunningChatQueueItem(state: ChatQueueState): ChatQueueItem | undefined {
  return selectChatQueueItems(state).find((item) => item.status === 'running');
}

export function selectChatQueueItemLiveness(
  state: ChatQueueState,
  aliases: { clientMsgId?: string; runId?: string; sourceRunId?: string },
): RunLiveness {
  return normalizeRunLiveness(selectChatQueueItem(state, aliases)?.liveness);
}

export function selectChatQueueMessageStatus(
  state: ChatQueueState,
  clientMsgId: string,
): ChatQueueStatus | ChatQueueLocalIntent['state'] | undefined {
  return state.items[clientMsgId]?.status ?? state.localIntents[clientMsgId]?.state;
}

/** Only unconfirmed UI intents; never use this selector to decide when to dispatch business work. */
export function selectChatQueueLocalIntents(state: ChatQueueState): ChatQueueLocalIntent[] {
  return Object.values(state.localIntents).sort((left, right) => left.createdAt - right.createdAt);
}

export function chatQueueStatusToMessageStatus(
  status: ChatQueueStatus,
): 'queued' | 'sent' | 'failed' {
  if (status === 'queued' || status === 'cancel_pending') return 'queued';
  if (status === 'failed') return 'failed';
  return 'sent';
}
