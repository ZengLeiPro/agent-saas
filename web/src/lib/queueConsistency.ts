import type { QueuedInterjection } from "./interjectionConsumption";

export type AuthoritativeSubmissionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type SubmissionProjection = 'queued' | 'sent' | 'failed' | 'cancelled';

/** ACK 与 HTTP 权威查询共用同一投影：只有已运行/完成才进入 sent。 */
export function projectAuthoritativeSubmissionStatus(
  status: AuthoritativeSubmissionStatus,
): SubmissionProjection {
  if (status === 'running' || status === 'completed') return 'sent';
  return status;
}

/** 停止当前 run 只会撤销 steering_inputs；普通 queue 仍须保留并等待后续串行执行。 */
export function markSteeringCancelledForStop(
  entries: QueuedInterjection[],
): QueuedInterjection[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (
      entry.deliveryMode !== "steer"
      || !["sending", "verifying", "queued"].includes(entry.status)
    ) {
      return entry;
    }
    changed = true;
    return { ...entry, status: "cancelled" as const, reason: "已随停止一并撤销" };
  });
  return changed ? next : entries;
}

/**
 * session 事件会改写当前路由：已有会话时只接受同会话事件；新会话草稿必须匹配
 * 当前待确认的 clientMessageId，迟到的旧事件不能接管页面。
 */
export function shouldAcceptSessionEvent(
  event: { sessionId: string; client_msg_id?: string },
  currentSessionId: string | null,
  pendingNewSessionClientMsgId: string | null,
): boolean {
  if (currentSessionId) return event.sessionId === currentSessionId;
  return Boolean(
    event.client_msg_id
    && pendingNewSessionClientMsgId
    && event.client_msg_id === pendingNewSessionClientMsgId,
  );
}

/** sync 事件溢出时，会话列表与当前详情都必须回源恢复。 */
export function recoverQueueSnapshotAfterSyncOverflow(session: {
  loadSessions: (options: { fresh: true }) => Promise<void>;
  refreshCurrentSession: () => void;
}): Promise<void> {
  session.refreshCurrentSession();
  return session.loadSessions({ fresh: true });
}

/** ACK 核验明确 not_found 后，释放本次提交占用的传输态；排队发送不得干扰当前 run。 */
export function finalizeNotFoundSubmission(input: {
  preserveActiveStream: boolean;
  markFailed: () => void;
  clearPendingSession: () => void;
  releaseTransport: () => void;
}): void {
  input.markFailed();
  input.clearPendingSession();
  if (!input.preserveActiveStream) input.releaseTransport();
}

/** 同一渲染帧内的重复点击只允许一个提交进入发送链路。 */
export function acquireMessageSubmissionSlot(
  gate: { current: boolean },
): (() => void) | null {
  if (gate.current) return null;
  gate.current = true;
  return () => {
    gate.current = false;
  };
}
