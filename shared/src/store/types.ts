/**
 * Chat Store Type Definitions
 *
 * 统一的状态管理类型，替代两端分散的 useState/useRef。
 * 使用 Zustand vanilla store，Web 和 Mobile 共用同一套状态逻辑。
 */

import type { MessageItem, MessageItemInput } from "../types/message";
import type { ApiSessionListItem, TokenUsage } from "../types/session";
import type { WsBlockState } from "../lib/wsEventProcessor";

// ── Connection ────────────────────────────────────────────────

export type ConnectionState =
  | "idle"
  | "connected"
  | "reconnecting"
  | "disconnected";
export type ConnectionAction =
  | "connect"
  | "drop"
  | "reconnect_ok"
  | "reconnect_fail"
  | "complete"
  | "reset";

// ── Messages Slice ────────────────────────────────────────────

export interface MessagesSlice {
  messages: MessageItem[];

  /** 内部可变数组（高频流式更新用，不触发 React 渲染） */
  getMessagesRef(): MessageItem[];
  addMessage(msg: MessageItemInput): number;
  updateMessageAt(
    index: number,
    updater: (m: MessageItem) => MessageItem,
  ): void;
  resetMessages(): void;
  setMessages(msgs: MessageItemInput[]): void;
  triggerScroll(): void;
  flushMessages(): void;

  /** 滚动控制标志（由 UI 层读写） */
  shouldScroll: boolean;
  setShouldScroll(v: boolean): void;
  isNearBottom: boolean;
  setIsNearBottom(v: boolean): void;
}

// ── Session Slice ─────────────────────────────────────────────

export interface SessionSlice {
  activeSessionId: string | null;
  sessions: ApiSessionListItem[];
  isLoadingSessions: boolean;
  isNewSession: boolean;
  tokenUsage: TokenUsage | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  deleteSessionId: string | null;
  /** 当前会话所有者 */
  sessionOwner: string | undefined;

  setActiveSessionId(id: string | null): void;
  setSessions(sessions: ApiSessionListItem[]): void;
  setIsLoadingSessions(v: boolean): void;
  setIsNewSession(v: boolean): void;
  setTokenUsage(usage: TokenUsage | null): void;
  setHasMore(v: boolean): void;
  setIsLoadingMore(v: boolean): void;
  setDeleteSessionId(id: string | null): void;
  setSessionOwner(owner: string | undefined): void;

  updateSessionTitle(sessionId: string, title: string): void;
  updateSessionMeta(
    sessionId: string,
    patch: { preview?: string; updatedAtMs?: number; title?: string },
  ): void;
  updateSessionStatus(sessionId: string, status: "busy" | "idle"): void;
  removeSession(sessionId: string): void;
  upsertSession(
    session: Partial<ApiSessionListItem> & {
      sessionId: string;
      updatedAtMs: number;
    },
  ): void;
}

// ── Stream Slice ──────────────────────────────────────────────

export interface StreamSlice {
  loading: boolean;
  stopping: boolean;
  streamId: string | null;
  runId: string | null;
  lastEventId: number | null;
  lastEventCursor: string | null;
  streamNonce: number;
  isAttached: boolean;
  latestStreamSessionId: string | null;
  userMsgIndex: number;
  blockState: WsBlockState;
  pendingMessage: { input: string; attachments: unknown[] } | null;
  /** sync 协议：用户级元数据事件序列号 */
  lastUserSeq: number;

  setLoading(v: boolean): void;
  setStopping(v: boolean): void;
  setStreamId(id: string | null): void;
  setRunId(id: string | null): void;
  setLastEventId(id: number | null): void;
  setLastEventCursor(cursor: string | null): void;
  incrementNonce(): number;
  setIsAttached(v: boolean): void;
  setLatestStreamSessionId(id: string | null): void;
  setUserMsgIndex(index: number): void;
  setBlockState(state: WsBlockState): void;
  setPendingMessage(
    msg: { input: string; attachments: unknown[] } | null,
  ): void;
  setLastUserSeq(seq: number): void;
}

// ── Connection Slice ──────────────────────────────────────────

export interface ConnectionSlice {
  connectionState: ConnectionState;
  dispatchConnection(action: ConnectionAction): void;
}

// ── Combined Store ────────────────────────────────────────────

export type ChatStore = MessagesSlice &
  SessionSlice &
  StreamSlice &
  ConnectionSlice;

/** 流状态初始值 */
export const INITIAL_BLOCK_STATE: WsBlockState = {
  currentBlockIndex: -1,
  currentBlockType: null,
};
