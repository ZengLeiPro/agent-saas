import type { ApiSessionListItem, SessionListActiveInteraction, SessionListPage } from '../types/session';

/** Canonical server/shared ordering: newest first, UUID/id descending as a stable tie-breaker. */
export function compareSessionListItems(
  left: Pick<ApiSessionListItem, 'updatedAtMs' | 'sessionId'>,
  right: Pick<ApiSessionListItem, 'updatedAtMs' | 'sessionId'>,
): number {
  return right.updatedAtMs - left.updatedAtMs || right.sessionId.localeCompare(left.sessionId);
}

export interface SessionListPagerState {
  generation: number;
  byId: Readonly<Record<string, ApiSessionListItem>>;
  order: readonly string[];
  tombstones: Readonly<Record<string, true>>;
  nextCursor: string | null;
  hasMore: boolean;
  pagingMode: 'cursor' | 'offset' | null;
  activeInteractionBySessionId: Readonly<Record<string, SessionListActiveInteraction>>;
  /** Incrementally maintained; consumers never scan transcript/event history. */
  orderedPendingSessionIds: readonly string[];
}

export type SessionListInteractionEvent =
  | { type: 'requested'; sessionId: string; interaction: SessionListActiveInteraction }
  | { type: 'ack'; sessionId: string; interactionId: string; status: 'accepted' | 'duplicate' | 'resolved' | 'rejected' | 'not_found' | 'expired' }
  | { type: 'resolved' | 'cancelled' | 'terminal'; sessionId: string; interactionId?: string };

export function createSessionListPagerState(): SessionListPagerState {
  return {
    generation: 0,
    byId: {},
    order: [],
    tombstones: {},
    nextCursor: null,
    hasMore: true,
    pagingMode: null,
    activeInteractionBySessionId: {},
    orderedPendingSessionIds: [],
  };
}

function orderSessions(byId: Readonly<Record<string, ApiSessionListItem>>): string[] {
  return Object.values(byId).sort(compareSessionListItems).map((session) => session.sessionId);
}

function orderPending(
  current: readonly string[],
  active: Readonly<Record<string, SessionListActiveInteraction>>,
  preferred: readonly string[] = [],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of [...preferred, ...current]) {
    if (!seen.has(id) && active[id]) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/** Starts a new authoritative refresh generation; pages from older generations are fenced out. */
export function beginSessionListRefresh(state: SessionListPagerState): SessionListPagerState {
  return {
    ...state,
    generation: state.generation + 1,
    nextCursor: null,
    hasMore: true,
    pagingMode: 'cursor',
  };
}

export function mergeSessionListPage(
  state: SessionListPagerState,
  input: SessionListPage & { generation: number; requestCursor?: string | null },
): SessionListPagerState {
  if (input.generation !== state.generation) return state;
  if (state.pagingMode === 'offset') return state;
  const firstPage = !input.requestCursor;
  const byId: Record<string, ApiSessionListItem> = firstPage ? {} : { ...state.byId };
  const active = firstPage ? {} as Record<string, SessionListActiveInteraction> : { ...state.activeInteractionBySessionId };
  const pagePending: string[] = [];
  for (const session of input.sessions) {
    if (state.tombstones[session.sessionId]) continue;
    const { activeInteraction, ...item } = session;
    byId[session.sessionId] = item;
    if (activeInteraction) {
      active[session.sessionId] = activeInteraction;
      pagePending.push(session.sessionId);
    } else {
      delete active[session.sessionId];
    }
  }
  return {
    ...state,
    byId,
    order: orderSessions(byId),
    nextCursor: input.nextCursor ?? null,
    hasMore: input.hasMore,
    pagingMode: 'cursor',
    activeInteractionBySessionId: active,
    orderedPendingSessionIds: orderPending(
      firstPage ? [] : state.orderedPendingSessionIds,
      active,
      pagePending,
    ),
  };
}

/** N-1 compatibility is isolated: a state generation may use offset pages or cursor pages, never both. */
export function mergeLegacyOffsetSessionPage(
  state: SessionListPagerState,
  input: { generation: number; sessions: readonly ApiSessionListItem[]; hasMore: boolean; replace?: boolean },
): SessionListPagerState {
  if (input.generation !== state.generation || state.pagingMode === 'cursor') return state;
  const byId: Record<string, ApiSessionListItem> = input.replace ? {} : { ...state.byId };
  for (const session of input.sessions) {
    if (!state.tombstones[session.sessionId]) byId[session.sessionId] = session;
  }
  return { ...state, byId, order: orderSessions(byId), hasMore: input.hasMore, pagingMode: 'offset' };
}

export function upsertSessionListItem(state: SessionListPagerState, session: ApiSessionListItem): SessionListPagerState {
  if (state.tombstones[session.sessionId]) return state;
  const { activeInteraction, ...item } = session;
  const byId = { ...state.byId, [session.sessionId]: { ...state.byId[session.sessionId], ...item } };
  let next: SessionListPagerState = { ...state, byId, order: orderSessions(byId) };
  if (activeInteraction) next = reduceSessionListInteraction(next, { type: 'requested', sessionId: session.sessionId, interaction: activeInteraction });
  return next;
}

export function tombstoneSessionListItem(state: SessionListPagerState, sessionId: string): SessionListPagerState {
  if (state.tombstones[sessionId]) return state;
  const byId = { ...state.byId }; delete byId[sessionId];
  const active = { ...state.activeInteractionBySessionId }; delete active[sessionId];
  return {
    ...state,
    byId,
    order: state.order.filter((id) => id !== sessionId),
    tombstones: { ...state.tombstones, [sessionId]: true },
    activeInteractionBySessionId: active,
    orderedPendingSessionIds: state.orderedPendingSessionIds.filter((id) => id !== sessionId),
  };
}

export function reduceSessionListInteraction(
  state: SessionListPagerState,
  event: SessionListInteractionEvent,
): SessionListPagerState {
  const current = state.activeInteractionBySessionId[event.sessionId];
  if (event.type === 'requested') {
    if (current && current.version > event.interaction.version) return state;
    const active = { ...state.activeInteractionBySessionId, [event.sessionId]: event.interaction };
    return {
      ...state,
      activeInteractionBySessionId: active,
      orderedPendingSessionIds: orderPending(state.orderedPendingSessionIds, active, [event.sessionId]),
    };
  }
  if (event.type === 'ack' && (event.status === 'accepted' || event.status === 'duplicate')) return state;
  if (event.interactionId && current?.interactionId !== event.interactionId) return state;
  if (!current) return state;
  const active = { ...state.activeInteractionBySessionId }; delete active[event.sessionId];
  return {
    ...state,
    activeInteractionBySessionId: active,
    orderedPendingSessionIds: state.orderedPendingSessionIds.filter((id) => id !== event.sessionId),
  };
}

/** O(1) active-interaction selector. */
export function selectActiveInteraction(
  state: SessionListPagerState,
  sessionId: string,
): SessionListActiveInteraction | undefined {
  return state.activeInteractionBySessionId[sessionId];
}

/** Pending sessions are pinned without changing canonical cursor/order state. */
export function selectSessionListItems(state: SessionListPagerState): ApiSessionListItem[] {
  const pending = state.orderedPendingSessionIds;
  const pinned = new Set(pending);
  return [...pending, ...state.order.filter((id) => !pinned.has(id))]
    .flatMap((id) => {
      const item = state.byId[id];
      if (!item) return [];
      const activeInteraction = state.activeInteractionBySessionId[id];
      return [{ ...item, ...(activeInteraction ? { activeInteraction } : {}) }];
    });
}
