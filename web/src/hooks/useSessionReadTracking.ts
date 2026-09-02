import { useCallback, useRef, type MutableRefObject } from 'react';
import type { ApiSessionListItem } from '@/lib/sessionsApi';
import type { AppTab } from '@/types/sidebar';
import type { MessageItem } from '@/components/types';
import { authFetch } from '@/lib/authFetch';
import { inferHistorySemanticOrder, selectSessionUnread, type UnreadSemanticItem } from '@agent/shared';

interface SessionReadTrackingOptions {
  session: {
    sessions: readonly ApiSessionListItem[];
    sessionId: string | null;
    updateSessionMeta: (sessionId: string, patch: { hasUnreadAiReply: false }) => void;
    loadSessions: () => unknown;
  };
  messagesRef: MutableRefObject<MessageItem[]>;
  isNearBottomRef: MutableRefObject<boolean>;
  immediateSessionIdRef: MutableRefObject<string | null>;
  activeTabRef: MutableRefObject<AppTab>;
  trashPreviewSessionIdRef: MutableRefObject<string | null>;
}

/** Own unread eligibility, optimistic projection, and the authenticated read receipt. */
export function useSessionReadTracking({
  session,
  messagesRef,
  isNearBottomRef,
  immediateSessionIdRef,
  activeTabRef,
  trashPreviewSessionIdRef,
}: SessionReadTrackingOptions): (targetSessionId: string | null | undefined) => void {
  const markingReadSessionIdsRef = useRef(new Set<string>());
  const { sessions, sessionId, updateSessionMeta, loadSessions } = session;

  return useCallback((targetSessionId: string | null | undefined) => {
    if (!targetSessionId || markingReadSessionIdsRef.current.has(targetSessionId)) return;
    const target = sessions.find((item) => item.sessionId === targetSessionId);
    if (target?.hasUnreadAiReply !== true) return;
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    const semanticItems: UnreadSemanticItem[] = messagesRef.current.map((message) => {
      const order = inferHistorySemanticOrder(message.id);
      return {
        semanticId: message.id,
        ...(order ? { order } : {}),
        kind: message.type === 'user' || message.type === 'user-voice'
          ? 'user'
          : message.type === 'permission_request' || message.type === 'ask_user'
            ? 'interaction'
            : 'assistant',
      };
    });
    const unread = selectSessionUnread({
      sessionId: targetSessionId,
      targetSessionId: (immediateSessionIdRef.current ?? sessionId) === targetSessionId ? targetSessionId : null,
      historyRevision: 'live',
      items: semanticItems,
      visible: visible && activeTabRef.current === 'chat' && !trashPreviewSessionIdRef.current,
      atBottom: isNearBottomRef.current,
      activeInteractionPending: target.activeInteraction !== undefined,
    });
    if (!unread.shouldMarkSeen) return;

    markingReadSessionIdsRef.current.add(targetSessionId);
    updateSessionMeta(targetSessionId, { hasUnreadAiReply: false });
    // Authorization-header requests intentionally omit include-level credentials for split-domain CORS.
    void authFetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/read`, { method: 'PUT' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      })
      .catch((error) => {
        console.warn(`Failed to mark session read ${targetSessionId}:`, error);
        void loadSessions();
      })
      .finally(() => {
        markingReadSessionIdsRef.current.delete(targetSessionId);
      });
  }, [activeTabRef, immediateSessionIdRef, isNearBottomRef, loadSessions, messagesRef, sessionId, sessions, trashPreviewSessionIdRef, updateSessionMeta]);
}
