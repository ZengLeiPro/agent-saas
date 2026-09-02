export interface HistorySemanticOrder {
  /** Canonical transcript/event sequence; never a timestamp. */
  sequence: number;
  /** Stable index within a sequence/event. */
  eventIndex: number;
  /** Stable tie-breaker for same-sequence collisions and retries. */
  stableId: string;
}

export interface HistorySemanticItem<T> {
  semanticId: string;
  order?: HistorySemanticOrder;
  value: T;
}

export interface HistoryPage<T> {
  items: readonly HistorySemanticItem<T>[];
  historyRevision: string;
  hasMore: boolean;
  nextCursor?: string;
  /** Cursor used by this request. null means a new latest-page generation. */
  requestCursor: string | null;
  generation: number;
}

interface StoredHistoryItem<T> extends HistorySemanticItem<T> {
  arrival: number;
}

export interface HistoryPagerState<T> {
  generation: number;
  historyRevision: string | null;
  byId: Readonly<Record<string, StoredHistoryItem<T>>>;
  orderedIds: readonly string[];
  tombstones: Readonly<Record<string, true>>;
  nextCursor?: string;
  hasMore: boolean;
  arrivalSequence: number;
}

export type HistoryPagerAction<T> =
  | { type: 'reset'; generation: number }
  | { type: 'page'; page: HistoryPage<T> }
  | { type: 'upsert'; generation: number; historyRevision?: string; item: HistorySemanticItem<T> }
  | { type: 'tombstone'; generation: number; historyRevision?: string; semanticId: string }
  | {
      type: 'compaction';
      generation: number;
      historyRevision: string;
      items: readonly HistorySemanticItem<T>[];
      hasMore: boolean;
      nextCursor?: string;
    };

export function createHistoryPagerState<T>(generation = 0): HistoryPagerState<T> {
  return {
    generation,
    historyRevision: null,
    byId: {},
    orderedIds: [],
    tombstones: {},
    hasMore: true,
    arrivalSequence: 0,
  };
}

export function compareHistorySemanticOrder(
  left: HistorySemanticOrder | undefined,
  right: HistorySemanticOrder | undefined,
): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.sequence - right.sequence
    || left.eventIndex - right.eventIndex
    || left.stableId.localeCompare(right.stableId);
}

/**
 * Legacy transcript ids encode a canonical physical sequence and an index inside the event.
 * Unknown ids intentionally return undefined: callers preserve deterministic arrival order
 * instead of guessing from timestamps.
 */
export function inferHistorySemanticOrder(semanticId: string): HistorySemanticOrder | undefined {
  const match = /^line-(\d+)(?:-.*?-(\d+))?(?:-|$)/.exec(semanticId);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  const eventIndex = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(eventIndex)) return undefined;
  return { sequence, eventIndex, stableId: semanticId };
}

function sortIds<T>(byId: Readonly<Record<string, StoredHistoryItem<T>>>): string[] {
  return Object.keys(byId).sort((leftId, rightId) => {
    const left = byId[leftId]!;
    const right = byId[rightId]!;
    return compareHistorySemanticOrder(left.order, right.order)
      || left.arrival - right.arrival
      || left.semanticId.localeCompare(right.semanticId);
  });
}

function replaceWithItems<T>(
  generation: number,
  historyRevision: string,
  items: readonly HistorySemanticItem<T>[],
  hasMore: boolean,
  nextCursor?: string,
): HistoryPagerState<T> {
  const byId: Record<string, StoredHistoryItem<T>> = {};
  let arrivalSequence = 0;
  for (const item of items) {
    if (!item.semanticId) continue;
    byId[item.semanticId] = { ...item, arrival: arrivalSequence++ };
  }
  return {
    generation,
    historyRevision,
    byId,
    orderedIds: sortIds(byId),
    tombstones: {},
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    arrivalSequence,
  };
}

/** Shared Web/Mobile history reducer: dedupe, generation/revision fences and compaction safety. */
export function reduceHistoryPager<T>(
  state: HistoryPagerState<T>,
  action: HistoryPagerAction<T>,
): HistoryPagerState<T> {
  if (action.type === 'reset') {
    return action.generation === state.generation
      ? state
      : createHistoryPagerState(action.generation);
  }
  const actionGeneration = action.type === 'page' ? action.page.generation : action.generation;
  if (actionGeneration !== state.generation) return state;
  if (action.type === 'compaction') {
    return replaceWithItems(
      state.generation,
      action.historyRevision,
      action.items,
      action.hasMore,
      action.nextCursor,
    );
  }

  const actionRevision = action.type === 'page' ? action.page.historyRevision : action.historyRevision;
  if (state.historyRevision && actionRevision && actionRevision !== state.historyRevision) {
    // Only a latest-page request may establish a new revision. Old in-flight pages are ignored.
    if (action.type === 'page' && action.page.requestCursor === null) {
      return replaceWithItems(
        state.generation,
        action.page.historyRevision,
        action.page.items,
        action.page.hasMore,
        action.page.nextCursor,
      );
    }
    return state;
  }

  if (action.type === 'tombstone') {
    if (!action.semanticId || state.tombstones[action.semanticId]) return state;
    const byId = { ...state.byId };
    delete byId[action.semanticId];
    return {
      ...state,
      historyRevision: state.historyRevision ?? action.historyRevision ?? null,
      byId,
      orderedIds: state.orderedIds.filter((id) => id !== action.semanticId),
      tombstones: { ...state.tombstones, [action.semanticId]: true },
    };
  }

  const page = action.type === 'page' ? action.page : undefined;
  const incoming = action.type === 'page' ? action.page.items : [action.item];
  let arrivalSequence = state.arrivalSequence;
  const byId: Record<string, StoredHistoryItem<T>> = { ...state.byId };
  let changed = false;
  for (const item of incoming) {
    if (!item.semanticId || state.tombstones[item.semanticId]) continue;
    const prior = byId[item.semanticId];
    const order = item.order ?? prior?.order;
    byId[item.semanticId] = {
      ...item,
      ...(order ? { order } : {}),
      arrival: prior?.arrival ?? arrivalSequence++,
    };
    changed = true;
  }
  if (!changed && !page) return state;
  return {
    ...state,
    historyRevision: state.historyRevision ?? actionRevision ?? null,
    byId,
    orderedIds: changed ? sortIds(byId) : state.orderedIds,
    ...(page?.nextCursor ? { nextCursor: page.nextCursor } : { nextCursor: undefined }),
    hasMore: page?.hasMore ?? state.hasMore,
    arrivalSequence,
  };
}

export function selectHistoryItems<T>(state: HistoryPagerState<T>): T[] {
  return state.orderedIds.map((id) => state.byId[id]!.value);
}

export function toHistorySemanticItem<T extends { id: string }>(value: T): HistorySemanticItem<T> {
  return {
    semanticId: value.id,
    ...(inferHistorySemanticOrder(value.id) ? { order: inferHistorySemanticOrder(value.id) } : {}),
    value,
  };
}

/** Convenience consumed by legacy page/delta adapters on both clients. */
export function mergeHistoryValues<T extends { id: string }>(
  base: readonly T[],
  incoming: readonly T[],
): T[] {
  let state = createHistoryPagerState<T>(1);
  state = reduceHistoryPager(state, {
    type: 'page',
    page: {
      items: base.map(toHistorySemanticItem),
      historyRevision: 'compat',
      hasMore: true,
      requestCursor: null,
      generation: 1,
    },
  });
  state = reduceHistoryPager(state, {
    type: 'page',
    page: {
      items: incoming.map(toHistorySemanticItem),
      historyRevision: 'compat',
      hasMore: false,
      requestCursor: 'compat',
      generation: 1,
    },
  });
  return selectHistoryItems(state);
}
