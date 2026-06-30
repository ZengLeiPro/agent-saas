/**
 * Session Slice — 会话列表 + 活跃会话状态
 *
 * activeSessionId 是唯一权威源，替代原来的三个 ref。
 */

import type { StateCreator } from 'zustand';
import type { ChatStore, SessionSlice } from '../types';
import type { ApiSessionListItem } from '../../types/session';

export const createSessionSlice: StateCreator<ChatStore, [], [], SessionSlice> = (set, get) => ({
  activeSessionId: null,
  sessions: [],
  isLoadingSessions: false,
  isNewSession: false,
  tokenUsage: null,
  hasMore: true,
  isLoadingMore: false,
  deleteSessionId: null,
  sessionOwner: undefined,

  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setSessions: (sessions) => set({ sessions }),
  setIsLoadingSessions: (v) => set({ isLoadingSessions: v }),
  setIsNewSession: (v) => set({ isNewSession: v }),
  setTokenUsage: (usage) => set({ tokenUsage: usage }),
  setHasMore: (v) => set({ hasMore: v }),
  setIsLoadingMore: (v) => set({ isLoadingMore: v }),
  setDeleteSessionId: (id) => set({ deleteSessionId: id }),
  setSessionOwner: (owner) => set({ sessionOwner: owner }),

  updateSessionTitle(sessionId: string, title: string): void {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.sessionId === sessionId ? { ...s, title } : s
      ),
    }));
  },

  updateSessionMeta(sessionId: string, patch: { preview?: string; updatedAtMs?: number; title?: string }): void {
    set(state => {
      const updated = state.sessions.map(s =>
        s.sessionId === sessionId
          ? {
              ...s,
              ...(patch.preview !== undefined ? { preview: patch.preview } : {}),
              ...(patch.updatedAtMs !== undefined ? { updatedAtMs: patch.updatedAtMs } : {}),
              ...(patch.title !== undefined ? { title: patch.title } : {}),
            }
          : s
      );
      updated.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      return { sessions: updated };
    });
  },

  updateSessionStatus(_sessionId: string, _status: 'busy' | 'idle'): void {
    // session status 不影响列表数据，由 UI 层按需订阅
    // 未来可在 sessions 中增加 status 字段
  },

  removeSession(sessionId: string): void {
    const state = get();
    set(s => ({ sessions: s.sessions.filter(item => item.sessionId !== sessionId) }));
    if (state.activeSessionId === sessionId) {
      state.resetMessages();
      set({ activeSessionId: null, tokenUsage: null });
    }
  },

  upsertSession(newSession: Partial<ApiSessionListItem> & { sessionId: string; updatedAtMs: number }): void {
    set(state => {
      const idx = state.sessions.findIndex(s => s.sessionId === newSession.sessionId);
      let updated: ApiSessionListItem[];
      if (idx >= 0) {
        updated = state.sessions.map(s =>
          s.sessionId === newSession.sessionId ? { ...s, ...newSession } : s
        );
      } else {
        const entry: ApiSessionListItem = {
          sessionId: newSession.sessionId,
          updatedAtMs: newSession.updatedAtMs,
          title: newSession.title,
          preview: newSession.preview,
          source: { type: 'web' as const, label: 'WEB' },
          ...(newSession.owner ? { owner: newSession.owner } : {}),
          ...(newSession.agent !== undefined ? { agent: newSession.agent } : {}),
          ...(newSession.model ? { model: newSession.model } : {}),
        };
        updated = [entry, ...state.sessions];
      }
      updated.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      return { sessions: updated };
    });
  },
});
