/** Queue-consistency projections kept separate from the orchestration hook. */
import type { WsProcessingContext, WsBlockState } from "@agent/shared";
import {
  InterjectionConsumptionRegistry,
  removeConsumedInterjections,
  type QueuedInterjection,
} from "@/lib/interjectionConsumption";
import { projectAuthoritativeSubmissionStatus } from "@/lib/queueConsistency";
import { isActiveRuntimeStatus } from "./chatRuntimeHelpers";
import type { OutboxEntry, SessionRuntime } from "./useChatAppStateTypes";

type MutableRef<T> = { current: T };
type QueueMutator = (updater: (prev: QueuedInterjection[]) => QueuedInterjection[]) => void;
type QueueCallbacks = Pick<WsProcessingContext,
  | 'onChatAck'
  | 'onActiveUserMsgIndexChange'
  | 'onStreamAttached'
  | 'onInterjectionApplied'
  | 'onSteeringAckQueued'
  | 'onMessageQueued'
  | 'onSteeringQueued'
  | 'onSteeringCancelled'
  | 'onSteeringPromoted'
  | 'onUserMessageProjected'
  | 'onChatRejected'
  | 'onChatDone'
>;

export interface QueueConsistencyCallbackArgs {
  ackTimersRef: MutableRef<Map<string, ReturnType<typeof setTimeout>>>;
  activeRunsBySession: MutableRef<Map<string, SessionRuntime>>;
  confirmProvisionalSession: (clientMsgId: string, sessionId: string) => void;
  consumedInterjectionsRef: MutableRef<InterjectionConsumptionRegistry>;
  failProvisionalBatch: (rootClientMsgId: string, reason: string) => void;
  immediateSessionIdRef: MutableRef<string | null>;
  markBubbleFailed: (clientMsgId: string | undefined, fallbackIndex: number, reason: string) => void;
  msgRef: MutableRef<WsProcessingContext['msg'] & {
    setMessages: NonNullable<WsProcessingContext['msg']['setMessages']>;
  }>;
  mutateQueuedInterjections: QueueMutator;
  newSessionClientMsgIdsRef: MutableRef<Set<string>>;
  outboxRef: MutableRef<OutboxEntry[]>;
  pendingNewSessionClientMsgIdRef: MutableRef<string | null>;
  queuedInterjectionsRef: MutableRef<QueuedInterjection[]>;
  sessionIdRef: MutableRef<string | null>;
  sessionRef: MutableRef<WsProcessingContext['session'] & { refreshCurrentSession: () => void }>;
  setLoading: (loading: boolean) => void;
  submissionBelongsToCurrentSession: (entry: OutboxEntry, authoritativeSessionId?: string) => boolean;
  wsAttachedRef: MutableRef<boolean>;
  wsBlockRef: MutableRef<WsBlockState>;
  wsUserMsgIndexRef: MutableRef<number>;
}

function removeOptimisticBubbleForQueue(
  clientMsgId: string,
  msgRef: QueueConsistencyCallbackArgs['msgRef'],
  wsBlockRef: QueueConsistencyCallbackArgs['wsBlockRef'],
  wsUserMsgIndexRef: QueueConsistencyCallbackArgs['wsUserMsgIndexRef'],
): void {
  const messages = msgRef.current.messagesRef.current;
  const index = messages.findIndex((message) => (
    (message.type === 'user' || message.type === 'user-voice') && message.clientMsgId === clientMsgId
  ));
  if (index < 0) return;
  msgRef.current.setMessages(messages.filter((_, candidateIndex) => candidateIndex !== index), { scrollToBottom: false });
  if (wsBlockRef.current.currentBlockIndex > index) {
    wsBlockRef.current = { ...wsBlockRef.current, currentBlockIndex: wsBlockRef.current.currentBlockIndex - 1 };
  } else if (wsBlockRef.current.currentBlockIndex === index) {
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
  }
  if (wsUserMsgIndexRef.current > index) wsUserMsgIndexRef.current -= 1;
  else if (wsUserMsgIndexRef.current === index) wsUserMsgIndexRef.current = -1;
}

export function createQueueConsistencyCallbacks(args: QueueConsistencyCallbackArgs): QueueCallbacks {
  const {
    ackTimersRef, activeRunsBySession, confirmProvisionalSession, consumedInterjectionsRef,
    failProvisionalBatch, immediateSessionIdRef, markBubbleFailed, msgRef, mutateQueuedInterjections,
    newSessionClientMsgIdsRef, outboxRef, pendingNewSessionClientMsgIdRef, queuedInterjectionsRef,
    sessionIdRef, sessionRef, setLoading, submissionBelongsToCurrentSession, wsAttachedRef,
    wsBlockRef, wsUserMsgIndexRef,
  } = args;
  return {
onChatAck: (clientMsgId, ackEvent) => {
  // 任一 durable ACK 都结束传输态；run 生命周期由队列/运行事件继续承载。
  const t = ackTimersRef.current.get(clientMsgId);
  if (t) { clearTimeout(t); ackTimersRef.current.delete(clientMsgId); }
  const ackedOutboxEntry = outboxRef.current.find((entry) => entry.clientMsgId === clientMsgId);
  outboxRef.current = outboxRef.current.filter((entry) => entry.clientMsgId !== clientMsgId);
  if (ackEvent?.type === 'chat_ack') {
    if (ackEvent.sessionId) confirmProvisionalSession(clientMsgId, ackEvent.sessionId);
    const currentSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
    const belongsToCurrentSession = ackEvent.sessionId
      ? ackEvent.sessionId === currentSessionId
      : ackedOutboxEntry
        ? submissionBelongsToCurrentSession(ackedOutboxEntry)
        : true;
    if (ackEvent.status === 'queued') {
      mutateQueuedInterjections((prev) => prev.map((entry) => entry.clientMsgId === clientMsgId ? {
        ...entry,
        ...(ackEvent.sessionId ? { sessionId: ackEvent.sessionId } : {}),
        status: 'queued' as const,
        sourceRunId: ackEvent.runId ?? entry.sourceRunId,
        deliveryMode: ackEvent.deliveryMode ?? entry.deliveryMode,
        ...(ackEvent.queuePosition ? { queuePosition: ackEvent.queuePosition } : {}),
        reason: undefined,
      } : entry));
    } else if (
      ackEvent.status === 'running'
      || ackEvent.status === 'completed'
      || ackEvent.status === 'failed'
      || ackEvent.status === 'cancelled'
    ) {
      const projection = projectAuthoritativeSubmissionStatus(ackEvent.status);
      if (belongsToCurrentSession) {
        consumedInterjectionsRef.current.mark({ clientMsgId, sourceRunId: ackEvent.runId });
      }
      const queuedEntry = queuedInterjectionsRef.current.find((entry) => entry.clientMsgId === clientMsgId);
      const index = belongsToCurrentSession
        ? msgRef.current.messagesRef.current.findIndex((message) => (
          (message.type === 'user' || message.type === 'user-voice') && message.clientMsgId === clientMsgId
        ))
        : -1;
      if (projection === 'sent') {
        mutateQueuedInterjections((prev) => prev.filter((entry) => entry.clientMsgId !== clientMsgId));
        if (index >= 0) {
          msgRef.current.updateMessageAt(index, (message) => (
            message.type === 'user' ? { ...message, status: 'sent' as const, failedReason: undefined } : message
          ));
        } else if (belongsToCurrentSession && queuedEntry) {
          msgRef.current.addMessage({
            type: 'user',
            content: queuedEntry.content,
            ...(queuedEntry.attachments ? { attachments: queuedEntry.attachments } : {}),
            status: 'sent',
            timestamp: queuedEntry.createdAt,
            clientMsgId,
          });
        }
      } else {
        const reason = projection === 'cancelled' ? '消息已取消，可重试' : '服务端执行失败，可重试';
        mutateQueuedInterjections((prev) => queuedEntry
          ? prev.map((entry) => entry.clientMsgId === clientMsgId
            ? { ...entry, status: projection, reason }
            : entry)
          : ackedOutboxEntry?.sessionId
            ? [...prev, {
              clientMsgId,
              sessionId: ackedOutboxEntry.sessionId,
              deliveryMode: ackedOutboxEntry.deliveryMode,
              content: ackedOutboxEntry.input,
              ...(ackedOutboxEntry.attachments.length ? { uploadedFiles: ackedOutboxEntry.attachments } : {}),
              status: projection,
              reason,
              createdAt: ackedOutboxEntry.createdAt,
            }]
            : prev);
        if (index >= 0) markBubbleFailed(clientMsgId, index, reason);
      }
      if (belongsToCurrentSession) {
        if (!ackedOutboxEntry?.preserveActiveStream) {
          setLoading(projection === 'sent' && ackEvent.status === 'running');
        }
        sessionRef.current.refreshCurrentSession();
      }
    }
  }
  // 专职 Agent 挂起 ref 不在 ACK 清（2026-07 审查 F9）：ACK 只代表消息入队，
  // 门禁/入队失败（chat_rejected）后重发仍需带 orgAgentId；
  // 改在 'session' 事件（服务端已写 meta 绑定）后清除
},
onActiveUserMsgIndexChange: (index) => {
  // 插话回退为独立 run 的接管：把防串校验的归属索引切到接管消息的气泡
  wsUserMsgIndexRef.current = index;
},
onStreamAttached: () => {
  // 接管场景：目标 run 的 done 已清掉 attached，这里恢复，后续流式内容才能过守卫
  wsAttachedRef.current = true;
},
onInterjectionApplied: (sourceRunIds, clientMsgIds) => {
  const applied = new Set(clientMsgIds);
  const appliedRuns = new Set(sourceRunIds);
  consumedInterjectionsRef.current.markMany(clientMsgIds, sourceRunIds);
  outboxRef.current = outboxRef.current.filter((entry) => !applied.has(entry.clientMsgId));
  for (const clientMsgId of clientMsgIds) {
    const timer = ackTimersRef.current.get(clientMsgId);
    if (timer) clearTimeout(timer);
    ackTimersRef.current.delete(clientMsgId);
  }
  // 队列区：被吸收的插话移除（气泡由 user_message 投影事件补进时间线）。
  // 消费标记还会拦截稍晚到达的 queued 广播/旧 detail 快照，避免队列栏反复复活。
  mutateQueuedInterjections((prev) => removeConsumedInterjections(prev, applied, appliedRuns));
},
// ── 插话队列区（2026-08-04 终态设计）──
onSteeringAckQueued: (clientMsgId, sourceRunId, targetRunId, queuedDeliveryMode, queuePosition) => {
  if (!clientMsgId || consumedInterjectionsRef.current.has({ clientMsgId, sourceRunId })) return;
  mutateQueuedInterjections((prev) => prev.map((entry) => (
    entry.clientMsgId === clientMsgId
      ? {
        ...entry,
        status: 'queued' as const,
        deliveryMode: queuedDeliveryMode === 'steer' ? 'steer' as const : entry.deliveryMode,
        ...(queuePosition ? { queuePosition } : {}),
        ...(sourceRunId ? { sourceRunId } : {}),
        ...(targetRunId ? { targetRunId } : {}),
      }
      : entry
  )));
},
onMessageQueued: (event) => {
  const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
  if (!sid || event.sessionId !== sid || consumedInterjectionsRef.current.has({
    clientMsgId: event.clientMsgId,
    sourceRunId: event.runId,
  })) return;
  removeOptimisticBubbleForQueue(event.clientMsgId, msgRef, wsBlockRef, wsUserMsgIndexRef);
  mutateQueuedInterjections((prev) => {
    const existing = prev.find((entry) => entry.clientMsgId === event.clientMsgId);
    if (existing) {
      return prev.map((entry) => entry.clientMsgId === event.clientMsgId ? {
        ...entry,
        sessionId: event.sessionId,
        status: 'queued' as const,
        sourceRunId: event.runId,
        deliveryMode: event.deliveryMode,
        ...(event.targetRunId ? { targetRunId: event.targetRunId } : {}),
        ...(event.queuePosition ? { queuePosition: event.queuePosition } : {}),
      } : entry);
    }
    return [...prev, {
      clientMsgId: event.clientMsgId,
      sessionId: event.sessionId,
      sourceRunId: event.runId,
      ...(event.targetRunId ? { targetRunId: event.targetRunId } : {}),
      deliveryMode: event.deliveryMode,
      ...(event.queuePosition ? { queuePosition: event.queuePosition } : {}),
      content: event.content,
      ...(event.attachments?.length ? { attachments: event.attachments } : {}),
      status: 'queued' as const,
      createdAt: event.timestamp,
    }];
  });
},
onSteeringQueued: (event) => {
  // user scope 多端广播：只处理当前会话；其他会话靠 detail API 恢复
  const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
  if (
    !sid
    || event.sessionId !== sid
    || consumedInterjectionsRef.current.has({
      clientMsgId: event.clientMsgId,
      sourceRunId: event.sourceRunId,
    })
  ) return;
  removeOptimisticBubbleForQueue(event.clientMsgId, msgRef, wsBlockRef, wsUserMsgIndexRef);
  mutateQueuedInterjections((prev) => {
    const existing = prev.find((entry) => entry.clientMsgId === event.clientMsgId);
    if (existing) {
      return prev.map((entry) => (
        entry.clientMsgId === event.clientMsgId
          ? { ...entry, status: 'queued' as const, sourceRunId: event.sourceRunId, targetRunId: event.targetRunId }
          : entry
      ));
    }
    return [...prev, {
      clientMsgId: event.clientMsgId,
      sessionId: event.sessionId,
      sourceRunId: event.sourceRunId,
      targetRunId: event.targetRunId,
      deliveryMode: 'steer' as const,
      content: event.content,
      ...(event.attachments?.length ? { attachments: event.attachments } : {}),
      status: 'queued' as const,
      createdAt: event.timestamp,
    }];
  });
},
onSteeringCancelled: (event) => {
  const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
  if (!sid || event.sessionId !== sid) return;
  mutateQueuedInterjections((prev) => prev.map((entry) => (
    (entry.sourceRunId && entry.sourceRunId === event.sourceRunId)
      || (event.clientMsgId && entry.clientMsgId === event.clientMsgId)
      ? {
        ...entry,
        status: 'cancelled' as const,
        reason: event.reason === 'aborted' ? '已随停止一并撤销' : '已撤回',
      }
      : entry
  )));
},
onSteeringPromoted: (clientMsgId, _streamId, _runId) => {
  // 插话回退为独立 run 被接管：队列区条目移入时间线成为正式 user 气泡
  if (!clientMsgId) return null;
  const entry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
  if (!entry) return null;
  consumedInterjectionsRef.current.mark({ clientMsgId, sourceRunId: _runId ?? entry.sourceRunId });
  mutateQueuedInterjections((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId));
  const index = msgRef.current.addMessage({
    type: 'user',
    content: entry.content,
    ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
    status: 'sent',
    timestamp: Date.now(),
    clientMsgId,
  });
  msgRef.current.triggerScroll();
  return index;
},
onUserMessageProjected: (clientMsgId, sourceRunId) => {
  if (!clientMsgId && !sourceRunId) return;
  consumedInterjectionsRef.current.mark({ clientMsgId, sourceRunId });
  mutateQueuedInterjections((prev) => removeConsumedInterjections(
    prev,
    new Set(clientMsgId ? [clientMsgId] : []),
    new Set(sourceRunId ? [sourceRunId] : []),
  ));
},
onChatRejected: (clientMsgId, reasonCode, reason) => {
  // 服务端拒绝：清 ACK 定时器、从 outbox 移除；bubble 已在 wsEventProcessor 翻 failed
  const t = ackTimersRef.current.get(clientMsgId);
  if (t) { clearTimeout(t); ackTimersRef.current.delete(clientMsgId); }
  outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== clientMsgId);
  if (pendingNewSessionClientMsgIdRef.current === clientMsgId) {
    failProvisionalBatch(clientMsgId, '会话建立被拒绝，请重新发送');
    pendingNewSessionClientMsgIdRef.current = null;
  }
  newSessionClientMsgIdsRef.current.delete(clientMsgId);
  // 插话被拒：只更新队列区条目，绝不动 loading/attached——当前 run 还在跑
  const queuedEntry = queuedInterjectionsRef.current.find((entry) => entry.clientMsgId === clientMsgId);
  if (queuedEntry) {
    if (reasonCode === 'duplicate_inflight') {
      // 重试撞上服务端已受理的原消息：移除本地条目，真态由
      // steering_queued/interjection_applied 广播或 detail 刷新补回。
      mutateQueuedInterjections((prev) => prev.filter((entry) => entry.clientMsgId !== clientMsgId));
    } else {
      mutateQueuedInterjections((prev) => prev.map((entry) => (
        entry.clientMsgId === clientMsgId
          ? { ...entry, status: 'failed' as const, reason: reason || '已被拒绝，可重试' }
          : entry
      )));
    }
    return;
  }
  // 清 loading 判定（2026-08-04 P1-2 修复）：outbox.every 在空数组上恒真，
  // 会把「后台已在跑、非本页发起」的 run 强制 detach（后续 done 全被防串守卫
  // 吞掉，界面卡死「正在思考」）。必须同时确认当前会话没有 active runtime。
  const rejectedSid = immediateSessionIdRef.current ?? sessionIdRef.current;
  const runtimeStillActive = rejectedSid
    ? isActiveRuntimeStatus(activeRunsBySession.current.get(rejectedSid)?.status)
    : false;
  if (
    !runtimeStillActive
    && outboxRef.current.every(e => e.state !== 'acked' && e.state !== 'sending')
  ) {
    wsAttachedRef.current = false;
    setLoading(false);
  }
},
onChatDone: (clientMsgId) => {
  if (!clientMsgId) return;
  const t = ackTimersRef.current.get(clientMsgId);
  if (t) { clearTimeout(t); ackTimersRef.current.delete(clientMsgId); }
  outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== clientMsgId);
  if (pendingNewSessionClientMsgIdRef.current === clientMsgId) {
    failProvisionalBatch(clientMsgId, '会话未完成建立，请重新发送');
    pendingNewSessionClientMsgIdRef.current = null;
  }
  newSessionClientMsgIdsRef.current.delete(clientMsgId);
},
  };
}

export type SendChatViaWs = (
  inputText: string,
  attachments: import("@/components/types").UploadedFile[],
  showBubble: boolean,
  voiceFile?: { savedPath: string; relativePath: string; duration: number },
  existingClientMsgId?: string,
  autoApproveRunShellForMessage?: boolean,
  preserveActiveStream?: boolean,
  deliveryMode?: 'queue' | 'steer',
) => Promise<void>;

export async function cancelQueuedEntry(args: {
  clientMsgId: string;
  queuedInterjectionsRef: MutableRef<QueuedInterjection[]>;
  cancelWaitersRef: MutableRef<Map<string, (ok: boolean) => void>>;
  mutateQueuedInterjections: QueueMutator;
  sendCancel: (sourceRunId: string) => Promise<boolean>;
}): Promise<boolean> {
  const { clientMsgId, queuedInterjectionsRef, cancelWaitersRef, mutateQueuedInterjections, sendCancel } = args;
  const entry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
  if (!entry) return false;
  if (entry.status === 'cancelled' || entry.status === 'failed') return true;
  if (!entry.sourceRunId || entry.status !== 'queued') return false;
  const sourceRunId = entry.sourceRunId;
  const ok = await new Promise<boolean>((resolve) => {
    cancelWaitersRef.current.set(sourceRunId, resolve);
    void sendCancel(sourceRunId).then((sent) => {
      if (!sent && cancelWaitersRef.current.has(sourceRunId)) {
        cancelWaitersRef.current.delete(sourceRunId);
        resolve(false);
      }
    });
    setTimeout(() => {
      if (cancelWaitersRef.current.has(sourceRunId)) {
        cancelWaitersRef.current.delete(sourceRunId);
        resolve(false);
      }
    }, 10_000);
  });
  if (ok) {
    mutateQueuedInterjections((prev) => prev.map((item) => item.clientMsgId === clientMsgId
      ? { ...item, status: 'cancelled' as const, reason: '已撤回' }
      : item));
  }
  return ok;
}

export function restoreQueuedEntryForEdit(args: {
  entry: QueuedInterjection;
  mutateQueuedInterjections: QueueMutator;
  setInput: (value: string) => void;
  uploadedFilesRef: MutableRef<import("@/components/types").UploadedFile[]>;
  replaceFiles: (files: import("@/components/types").UploadedFile[]) => void;
}): void {
  const { entry } = args;
  args.mutateQueuedInterjections((prev) => prev.filter((item) => item.clientMsgId !== entry.clientMsgId));
  args.setInput(entry.content);
  const attachments = entry.uploadedFiles ?? [];
  args.uploadedFilesRef.current = attachments;
  args.replaceFiles(attachments);
}

export function resendQueuedEntry(args: {
  clientMsgId: string;
  queuedInterjectionsRef: MutableRef<QueuedInterjection[]>;
  mutateQueuedInterjections: QueueMutator;
  loadingRef: MutableRef<boolean>;
  autoApproveRunShellRef: MutableRef<boolean>;
  sendChatViaWs: SendChatViaWs;
}): void {
  const entry = args.queuedInterjectionsRef.current.find((item) => item.clientMsgId === args.clientMsgId);
  if (!entry || (entry.status !== 'cancelled' && entry.status !== 'failed')) return;
  args.mutateQueuedInterjections((prev) => prev.filter((item) => item.clientMsgId !== args.clientMsgId));
  const attachments = entry.uploadedFiles ?? [];
  if (args.loadingRef.current) {
    const clientMsgId = crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    args.mutateQueuedInterjections((prev) => [...prev, {
      clientMsgId,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      deliveryMode: entry.deliveryMode,
      content: entry.content,
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      ...(attachments.length ? { uploadedFiles: attachments } : {}),
      status: 'sending' as const,
      createdAt: Date.now(),
    }]);
    void args.sendChatViaWs(entry.content, attachments, false, undefined, clientMsgId, args.autoApproveRunShellRef.current, true, entry.deliveryMode);
  } else {
    void args.sendChatViaWs(entry.content, attachments, true);
  }
}

export function dismissQueuedEntry(
  clientMsgId: string,
  mutateQueuedInterjections: QueueMutator,
): void {
  mutateQueuedInterjections((prev) => prev.filter((item) => (
    item.clientMsgId !== clientMsgId || (item.status !== 'cancelled' && item.status !== 'failed')
  )));
}
