import type { MessageItem } from '../types/message';

type RuntimeStatusMessage = Extract<MessageItem, { type: "runtime_status" }>;
export type RuntimeStatus = RuntimeStatusMessage["status"];
export interface RuntimeStatusOptions {
  content?: string;
  streamId?: string;
  runId?: string;
}
export type RuntimeStatusPatch = Pick<RuntimeStatusMessage, "status" | "content" | "streaming">
  & Partial<Pick<RuntimeStatusMessage, "streamId" | "runId">>;

/** active_stream / session_status 重复广播 running 时，更精确的尾部活动应优先展示。 */
export function hasTrailingActiveWork(messages: MessageItem[], runId?: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === "runtime_status") continue;
    if (runId && "runId" in message && message.runId && message.runId !== runId) return false;
    if ((message.type === "text" || message.type === "thinking") && message.streaming) return true;
    if (message.type === "subagent" && message.status === "running") return true;
    if (message.type === "tool_use") {
      return message.streaming === true
        || message.executionStatus === "running"
        || (!message.resultReady
          && message.executionStatus !== "completed"
          && message.executionStatus !== "failed"
          && message.executionStatus !== "cancelled");
    }
    return false;
  }
  return false;
}

function runtimeStatusText(status: RuntimeStatus): string {
  switch (status) {
    case "sending": return "正在发送消息";
    case "queued": return "已进入队列";
    case "running": return "正在思考";
    case "waiting_hand": return "正在准备工作区";
    case "waiting_approval": return "待处理";
    case "waiting_user": return "待补充";
    case "reconnecting": return "正在恢复连接";
    default: return "正在处理";
  }
}

/** Builds the visible runtime-status transition, or null when a duplicate event is a no-op. */
export function resolveRuntimeStatusPatch(
  current: RuntimeStatusMessage | undefined,
  status: RuntimeStatus,
  options: RuntimeStatusOptions = {},
): RuntimeStatusPatch | null {
  const content = options.content ?? runtimeStatusText(status);
  const streamId = options.streamId ?? current?.streamId;
  const runId = options.runId ?? current?.runId;
  if (
    current?.status === status
    && current.content === content
    && current.streamId === streamId
    && current.runId === runId
    && current.streaming === true
  ) return null;
  return {
    status,
    content,
    ...(streamId ? { streamId } : {}),
    ...(runId ? { runId } : {}),
    streaming: true,
  };
}
