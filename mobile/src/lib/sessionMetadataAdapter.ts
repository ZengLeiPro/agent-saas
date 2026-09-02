import {
  createSessionMetadataState,
  reduceSessionMetadata,
  type ApiSessionListItem,
  type SessionMetadataAction,
  type SessionMetadataState,
} from '@agent/shared';

/** Mobile is intentionally a thin adapter: AsyncStorage is startup-only, never authoritative. */
export function createMobileSessionMetadataState(identityGeneration: string | null, cached: readonly ApiSessionListItem[] = []): SessionMetadataState {
  return reduceSessionMetadata(createSessionMetadataState(identityGeneration), {
    type: 'hydrate', sessions: cached.map((session) => ({ ...session, hasUnread: session.hasUnreadAiReply ?? false })), authoritative: false,
  });
}

export function reduceMobileSessionMetadata(state: SessionMetadataState, action: SessionMetadataAction): SessionMetadataState {
  return reduceSessionMetadata(state, action);
}
