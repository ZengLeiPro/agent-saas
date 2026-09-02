/** Cohesive message state helpers and contracts for the WS event processor. */
import type { MessageItem, MessageItemInput } from '../types/message';
import type { WsEvent } from '../types/ws';
import type { ActivityMessageProjectionState } from './activityMessageProjection';

/** Messages controller interface — platform-agnostic subset */
export interface MessagesController {
  messagesRef: { current: MessageItem[] };
  addMessage: (message: MessageItemInput) => number;
  updateMessageAt: (index: number, updater: (msg: MessageItem) => MessageItem) => void;
  setMessages?: (messages: MessageItemInput[], options?: { scrollToBottom?: boolean }) => void;
  triggerScroll: () => void;
}

/** WS event processing context */
export interface WsProcessingContext {
  msg: MessagesController;
  session: {
    setIsNewSession: (v: boolean) => void;
    setSessionId: (id: string | null) => void;
    loadSessions: () => Promise<void>;
    updateSessionTitle: (sessionId: string, title: string) => void;
    updateSessionMeta: (sessionId: string, patch: { preview?: string; updatedAtMs?: number; title?: string; hasUnreadAiReply?: boolean }) => void;
    removeSession: (sessionId: string) => void;
    upsertSession?: (session: { sessionId: string; title?: string; preview?: string; updatedAtMs: number; model?: string; username?: string }) => void;
  };
  selectedModelRef: { current: string | null };
  voiceCallbackRef: { current: ((key: string, text: string, voice?: string, speed?: number) => void) | undefined };
  streamIdRef: { current: string | null };
  runIdRef?: { current: string | null };
  /** 已处理的终态键（runId 优先，兼容旧协议时回退 client_msg_id） */
  handledTerminalKeysRef?: { current: Set<string> };
  lastEventIdRef: { current: number | null };
  userMsgIndex: number;
  /** Platform storage callback for persisting model selection */
  onModelPersist?: (sessionId: string, model: string) => void;
  /** 当前会话所属用户（admin 查看其他用户会话时需要，用于文件路径解析） */
  sessionOwnerRef?: { current: string | undefined };
  /** 消息可靠性协议回调（2026-04-18 新增）—— 用于 outbox 状态机更新 */
  onChatAck?: (clientMsgId: string, event?: WsEvent) => void;
  onInterjectionApplied?: (sourceRunIds: string[], clientMsgIds: string[]) => void;
  /**
   * 活跃流接管到另一条用户消息时回调（非 queued 的 stream_id 按 client_msg_id 定位到
   * 非当前 userMsgIndex 的气泡）。典型场景：插话未能在目标 run 边界注入、回退为独立
   * run 执行——上层必须把 userMsgIndex 切到该气泡，否则接管 run 的 done 会被
   * client_msg_id 防串校验丢弃（流式内容永不确定、outbox 条目泄漏）。
   */
  onActiveUserMsgIndexChange?: (index: number) => void;
  /**
   * 非 queued 的 stream_id 把活跃流绑定到本连接时回调（含插话回退 run 的接管）。
   * 上层用它恢复 attached 状态——接管场景下目标 run 的 done 已把 attached 清掉，
   * 不恢复的话后续流式内容会被防串流守卫整体丢弃。
   */
  onStreamAttached?: (streamId: string, runId: string | null) => void;
  onChatRejected?: (clientMsgId: string, reasonCode: string, reason: string) => void;
  /** done 事件（可能带 error）时被调用，用于同步 outbox 终态 */
  onChatDone?: (clientMsgId: string | undefined, error: string | undefined) => void;
  // ── 插话队列区（2026-08-04 终态设计）──
  /** stream_id{queued:true} ACK：本地队列区条目确认排队成功并记录 sourceRunId。 */
  onSteeringAckQueued?: (clientMsgId: string | undefined, sourceRunId: string | undefined, targetRunId: string | undefined, deliveryMode?: 'queue' | 'steer', queuePosition?: number) => void;
  /** 统一 message_queued 广播（user scope，多端）。 */
  onMessageQueued?: (entry: Extract<WsEvent, { type: 'message_queued' }>) => void;
  /** steering_queued 广播（旧协议兼容）。 */
  onSteeringQueued?: (entry: Extract<WsEvent, { type: 'steering_queued' }>) => void;
  /** steering_cancelled 广播：队列区条目标记已取消（abort 联动/其他端撤回）。 */
  onSteeringCancelled?: (event: Extract<WsEvent, { type: 'steering_cancelled' }>) => void;
  /**
   * 非 queued 的 stream_id 命中队列区条目时（插话回退为独立 run 被接管执行）：
   * 上层负责把条目移出队列区并在时间线末尾补 user 气泡，返回新气泡 index；
   * 返回 null/undefined 表示 clientMsgId 不在队列区（走旧的气泡定位路径）。
   */
  onSteeringPromoted?: (clientMsgId: string | undefined, streamId: string, runId: string | undefined) => number | null | undefined;
  /** 插话被消费进时间线（user_message 投影）：按 clientMsgId/sourceRunId 清理队列区并阻止旧状态复活。 */
  onUserMessageProjected?: (clientMsgId: string | undefined, sourceRunId: string | undefined) => void;
}

/** 在消息数组里按 clientMsgId 查找 user / user-voice 消息的索引，找不到返回 -1 */
export function findUserMsgIndexByClientId(msgs: MessageItem[], clientMsgId: string): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if ((m.type === 'user' || m.type === 'user-voice') && 'clientMsgId' in m && m.clientMsgId === clientMsgId) {
      return i;
    }
  }
  return -1;
}

export interface WsBlockState {
  currentBlockIndex: number;
  currentBlockType: string | null;
  /** Canonical identity state for modern frames; positional fields above are legacy-only. */
  projectionState?: ActivityMessageProjectionState;
}
