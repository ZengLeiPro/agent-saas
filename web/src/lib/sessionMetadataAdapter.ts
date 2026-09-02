import {
  createSessionMetadataState,
  reduceSessionMetadata,
  type ApiSessionListItem,
  type SessionMetadataAction,
  type SessionMetadataState,
} from '@agent/shared';

/** Web is intentionally a thin adapter: cache seeds state; network hydrate is authoritative. */
export function createWebSessionMetadataState(identityGeneration: string | null, cached: readonly ApiSessionListItem[] = []): SessionMetadataState {
  return reduceSessionMetadata(createSessionMetadataState(identityGeneration), {
    type: 'hydrate', sessions: cached.map((session) => ({ ...session, hasUnread: session.hasUnreadAiReply ?? false })), authoritative: false,
  });
}

export function reduceWebSessionMetadata(state: SessionMetadataState, action: SessionMetadataAction): SessionMetadataState {
  return reduceSessionMetadata(state, action);
}
