import type { ApiSessionListItem } from '../types/session';

export interface CanonicalSessionMetadata extends ApiSessionListItem {
  /** Monotonic server metadata version. */
  version?: number;
  /** Last read acknowledgement sequence/version. */
  readSeq?: number;
  readAt?: string;
  hasUnread: boolean;
  /** Fail-closed terminal tombstone. There is intentionally no implicit restore action. */
  deleted: boolean;
  serverUpdatedAt?: string;
  sourceSeq?: number;
}

export interface SessionMetadataState {
  byId: Readonly<Record<string, CanonicalSessionMetadata>>;
  order: readonly string[];
  selectedSessionId: string | null;
  identityGeneration: string | null;
  pendingRead: Readonly<Record<string, CanonicalSessionMetadata>>;
}

export type SessionMetadataPatch = Partial<Omit<CanonicalSessionMetadata, 'sessionId'>> & {
  sessionId: string;
  serverVersion?: number;
  updatedAt?: string;
};

export type SessionMetadataAction =
  | { type: 'hydrate'; sessions: readonly SessionMetadataPatch[]; authoritative?: boolean }
  | { type: 'metadata'; session: SessionMetadataPatch }
  | { type: 'delete'; sessionId: string; serverVersion?: number; updatedAt?: string; sourceSeq?: number }
  | { type: 'select'; sessionId: string | null }
  | { type: 'read_optimistic'; sessionId: string }
  | { type: 'read_ack'; session: SessionMetadataPatch }
  | { type: 'read_failed'; sessionId: string }
  | { type: 'identity_reset'; generation: string | null }
  | { type: 'access_lost'; sessionId: string };

export function createSessionMetadataState(generation: string | null = null): SessionMetadataState {
  return { byId: {}, order: [], selectedSessionId: null, identityGeneration: generation, pendingRead: {} };
}

function normalized(patch: SessionMetadataPatch, prior?: CanonicalSessionMetadata): CanonicalSessionMetadata {
  const { serverVersion, updatedAt, ...rest } = patch;
  return {
    updatedAtMs: 0,
    hasUnread: patch.hasUnread ?? patch.hasUnreadAiReply ?? prior?.hasUnread ?? false,
    deleted: patch.deleted ?? prior?.deleted ?? false,
    ...prior,
    ...rest,
    sessionId: patch.sessionId,
    ...(serverVersion !== undefined ? { version: serverVersion } : {}),
    ...(updatedAt !== undefined ? { serverUpdatedAt: updatedAt } : {}),
  };
}

function clockOf(value: SessionMetadataPatch | CanonicalSessionMetadata): [number | undefined, number | undefined, number | undefined] {
  const version = 'serverVersion' in value ? value.serverVersion : value.version;
  const sourceSeq = value.sourceSeq;
  const updated = 'updatedAt' in value ? value.updatedAt : value.serverUpdatedAt;
  const updatedMs = updated ? Date.parse(updated) : undefined;
  return [version, sourceSeq, Number.isFinite(updatedMs) ? updatedMs : undefined];
}

/** Versioned state is never overwritten by an N-1 versionless event. */
function isNewerOrEqual(prior: CanonicalSessionMetadata | undefined, patch: SessionMetadataPatch): boolean {
  if (!prior) return true;
  const [pv, ps, pt] = clockOf(prior);
  const [nv, ns, nt] = clockOf(patch);
  if (pv !== undefined) return nv !== undefined && nv >= pv;
  if (nv !== undefined) return true;
  if (ps !== undefined) return ns !== undefined && ns >= ps;
  if (ns !== undefined) return true;
  if (pt !== undefined && nt !== undefined) return nt >= pt;
  return pt === undefined;
}

function sortedOrder(byId: Readonly<Record<string, CanonicalSessionMetadata>>): string[] {
  return Object.values(byId)
    .filter((session) => !session.deleted)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.sessionId.localeCompare(a.sessionId))
    .map((session) => session.sessionId);
}

function fallbackSelection(state: SessionMetadataState, byId: Readonly<Record<string, CanonicalSessionMetadata>>, removedId: string): string | null {
  if (state.selectedSessionId !== removedId) return state.selectedSessionId;
  const oldIndex = Math.max(0, state.order.indexOf(removedId));
  const order = sortedOrder(byId);
  return order[Math.min(oldIndex, Math.max(0, order.length - 1))] ?? null;
}

function applyPatch(state: SessionMetadataState, patch: SessionMetadataPatch): SessionMetadataState {
  const prior = state.byId[patch.sessionId];
  // A tombstone is terminal. Product has no explicit restore protocol.
  if (prior?.deleted || !isNewerOrEqual(prior, patch)) return state;
  const next = normalized(patch, prior);
  const byId = { ...state.byId, [patch.sessionId]: next };
  return { ...state, byId, order: sortedOrder(byId) };
}

export function reduceSessionMetadata(state: SessionMetadataState, action: SessionMetadataAction): SessionMetadataState {
  switch (action.type) {
    case 'identity_reset':
      return action.generation === state.identityGeneration ? state : createSessionMetadataState(action.generation);
    case 'select':
      return action.sessionId === null || (state.byId[action.sessionId] && !state.byId[action.sessionId].deleted)
        ? { ...state, selectedSessionId: action.sessionId }
        : state;
    case 'hydrate': { // cache uses authoritative=false; network truth uses authoritative=true
      let next = state;
      const incoming = new Set<string>();
      for (const session of action.sessions) {
        incoming.add(session.sessionId);
        next = applyPatch(next, session);
      }
      if (action.authoritative) {
        const byId = { ...next.byId };
        for (const id of Object.keys(byId)) {
          if (!incoming.has(id) && !byId[id].deleted) delete byId[id];
        }
        next = { ...next, byId, order: sortedOrder(byId) };
        if (next.selectedSessionId && !byId[next.selectedSessionId]) next = { ...next, selectedSessionId: null };
      }
      return next;
    }
    case 'metadata':
    case 'read_ack': {
      const next = applyPatch(state, action.session);
      if (action.type !== 'read_ack') return next;
      const pendingRead = { ...next.pendingRead }; delete pendingRead[action.session.sessionId];
      return { ...next, pendingRead };
    }
    case 'delete': { // N-1 delete is deliberately fail-closed even without version.
      const prior = state.byId[action.sessionId];
      if (prior?.deleted) return state;
      const tombstone = normalized({ sessionId: action.sessionId, deleted: true, serverVersion: action.serverVersion, updatedAt: action.updatedAt, sourceSeq: action.sourceSeq }, prior);
      const byId = { ...state.byId, [action.sessionId]: tombstone };
      const pendingRead = { ...state.pendingRead }; delete pendingRead[action.sessionId];
      return { ...state, byId, order: sortedOrder(byId), pendingRead, selectedSessionId: fallbackSelection(state, byId, action.sessionId) };
    }
    case 'access_lost':
      return reduceSessionMetadata(state, { type: 'delete', sessionId: action.sessionId });
    case 'read_optimistic': { // retained snapshot guarantees failed ACK cannot permanently clear unread.
      const prior = state.byId[action.sessionId];
      if (!prior || prior.deleted || !prior.hasUnread) return state;
      return {
        ...state,
        byId: { ...state.byId, [action.sessionId]: { ...prior, hasUnread: false, hasUnreadAiReply: false } },
        pendingRead: { ...state.pendingRead, [action.sessionId]: prior },
      };
    }
    case 'read_failed': {
      const snapshot = state.pendingRead[action.sessionId];
      if (!snapshot) return state;
      const pendingRead = { ...state.pendingRead }; delete pendingRead[action.sessionId];
      const current = state.byId[action.sessionId];
      const [snapshotVersion, snapshotSeq] = clockOf(snapshot);
      const [currentVersion, currentSeq] = current ? clockOf(current) : [];
      const advanced = (currentVersion !== undefined && snapshotVersion !== undefined && currentVersion > snapshotVersion)
        || (currentVersion === undefined && currentSeq !== undefined && snapshotSeq !== undefined && currentSeq > snapshotSeq);
      return advanced ? { ...state, pendingRead } : { ...state, byId: { ...state.byId, [action.sessionId]: snapshot }, pendingRead };
    }
  }
}

export function sessionMetadataEventFromWs(event: {
  type: string; sessionId: string; title?: string; preview?: string; updatedAtMs?: number;
  hasUnreadAiReply?: boolean; serverVersion?: number; updatedAt?: string; sourceSeq?: number;
}): SessionMetadataAction | null {
  if (event.type === 'session_deleted') return { type: 'delete', sessionId: event.sessionId, serverVersion: event.serverVersion, updatedAt: event.updatedAt, sourceSeq: event.sourceSeq };
  if (event.type === 'title_updated') return { type: 'metadata', session: { ...event, version: event.serverVersion, hasUnread: undefined } };
  if (event.type === 'session_updated' || event.type === 'session_read_state_changed') {
    return { type: 'metadata', session: { ...event, version: event.serverVersion, hasUnread: event.hasUnreadAiReply } };
  }
  return null;
}
