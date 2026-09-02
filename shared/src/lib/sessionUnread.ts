import type { HistorySemanticOrder } from './historyPager';
import { compareHistorySemanticOrder } from './historyPager';

export type SemanticUnreadKind = 'user' | 'assistant' | 'business_step' | 'interaction' | 'other' | 'unknown';

export interface UnreadSemanticItem {
  semanticId: string;
  order?: HistorySemanticOrder;
  kind: SemanticUnreadKind;
  /** BusinessStep transitions are unread-worthy; snapshots/repeats are not. */
  businessStepChanged?: boolean;
}

export interface SessionSeenState {
  sessionId: string;
  lastSeenSemanticId?: string;
  revision?: string;
}

export interface SessionUnreadInput {
  sessionId: string;
  targetSessionId: string | null;
  historyRevision: string;
  items: readonly UnreadSemanticItem[];
  seen?: SessionSeenState;
  visible: boolean;
  atBottom: boolean;
  activeInteractionPending?: boolean;
}

export interface SessionUnreadSelection {
  unreadCount: number;
  hasUnread: boolean;
  shouldMarkSeen: boolean;
  pendingInteraction: boolean;
  latestCountableSemanticId?: string;
}

function isCountable(item: UnreadSemanticItem): boolean {
  if (item.kind === 'assistant') return true;
  return item.kind === 'business_step' && item.businessStepChanged === true;
}

function semanticItems(items: readonly UnreadSemanticItem[]): UnreadSemanticItem[] {
  return [...items].sort((left, right) => (
    compareHistorySemanticOrder(left.order, right.order)
    || left.semanticId.localeCompare(right.semanticId)
  ));
}

/** Canonical unread selector shared by Web/Mobile. Receipt alone never clears unread. */
export function selectSessionUnread(input: SessionUnreadInput): SessionUnreadSelection {
  const ordered = semanticItems(input.items);
  const markerIndex = input.seen?.sessionId === input.sessionId && input.seen.lastSeenSemanticId
    ? ordered.findIndex((item) => item.semanticId === input.seen!.lastSeenSemanticId)
    : -1;
  const afterMarker = markerIndex >= 0 ? ordered.slice(markerIndex + 1) : ordered;
  const unread = afterMarker.filter(isCountable);
  const latestCountableSemanticId = [...ordered].reverse().find(isCountable)?.semanticId;
  const targetVisibleAtBottom = input.visible
    && input.atBottom
    && input.targetSessionId === input.sessionId;
  return {
    unreadCount: targetVisibleAtBottom ? 0 : unread.length,
    hasUnread: !targetVisibleAtBottom && unread.length > 0,
    shouldMarkSeen: Boolean(targetVisibleAtBottom && latestCountableSemanticId && (
      input.seen?.lastSeenSemanticId !== latestCountableSemanticId
      || input.seen?.revision !== input.historyRevision
    )),
    pendingInteraction: input.activeInteractionPending === true,
    ...(latestCountableSemanticId ? { latestCountableSemanticId } : {}),
  };
}

/** Atomic payload to persist only when selectSessionUnread.shouldMarkSeen is true. */
export function createSessionSeenCommit(
  input: SessionUnreadInput,
  selection: SessionUnreadSelection = selectSessionUnread(input),
): SessionSeenState | null {
  if (!selection.shouldMarkSeen || !selection.latestCountableSemanticId) return null;
  return {
    sessionId: input.sessionId,
    lastSeenSemanticId: selection.latestCountableSemanticId,
    revision: input.historyRevision,
  };
}
