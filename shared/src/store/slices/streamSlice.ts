/**
 * Stream Slice — 流式传输控制状态
 *
 * 管理 loading/stopping/streamId/isAttached/pendingMessage 等，
 * 替代原来分散在 useChatAppState 中的多个 ref。
 */

import type { StateCreator } from 'zustand';
import type { ChatStore, StreamSlice } from '../types';
import { INITIAL_BLOCK_STATE } from '../types';

export const createStreamSlice: StateCreator<ChatStore, [], [], StreamSlice> = (set, get) => ({
  loading: false,
  stopping: false,
  streamId: null,
  runId: null,
  lastEventId: null,
  lastEventCursor: null,
  streamNonce: 0,
  isAttached: false,
  latestStreamSessionId: null,
  userMsgIndex: -1,
  blockState: { ...INITIAL_BLOCK_STATE },
  pendingMessage: null,
  lastUserSeq: 0,

  setLoading: (v) => set({ loading: v }),
  setStopping: (v) => set({ stopping: v }),
  setStreamId: (id) => set({ streamId: id }),
  setRunId: (id) => set({ runId: id }),
  setLastEventId: (id) => set({ lastEventId: id }),
  setLastEventCursor: (cursor) => set({ lastEventCursor: cursor }),
  incrementNonce(): number {
    const next = get().streamNonce + 1;
    set({ streamNonce: next });
    return next;
  },
  setIsAttached: (v) => set({ isAttached: v }),
  setLatestStreamSessionId: (id) => set({ latestStreamSessionId: id }),
  setUserMsgIndex: (index) => set({ userMsgIndex: index }),
  setBlockState: (state) => set({ blockState: state }),
  setPendingMessage: (msg) => set({ pendingMessage: msg }),
  setLastUserSeq: (seq) => set({ lastUserSeq: seq }),
});
