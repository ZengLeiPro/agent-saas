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

function runtimeStatusText(status: RuntimeStatus): string {
  switch (status) {
    case "sending": return "正在发送消息";
    case "queued": return "已进入队列";
    case "running": return "正在思考";
    case "waiting_hand": return "正在准备工作区";
    case "waiting_approval": return "等待授权";
    case "waiting_user": return "等待补充信息";
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
