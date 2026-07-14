/**
 * WS event processor — pure functions for handling WebSocket events.
 * Platform-agnostic: no browser-specific APIs.
 */

import type { MessageItem, MessageItemInput } from '../types/message';
import type { WsEvent } from '../types/ws';
import { formatRuntimeFailureMessage, isInsufficientCreditsFailure } from './runtimeErrorMessage';

/**
 * 拥有独立卡片的工具：交互工具走 ask_user / permission_request，Agent 走
 * subagent_start / subagent_end。它们不该再走通用 tool_use / tool_result 通道。
 * 此常量是旧 buffer / 跨版本重连的前端兜底，与后端 displayFilter 保持一致。
 */
const DEDICATED_TOOL_NAMES = new Set<string>([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Agent",
]);

function isDedicatedToolName(toolName: string | undefined | null): boolean {
  return !!toolName && DEDICATED_TOOL_NAMES.has(toolName);
}

/** Plan mode tool display mapping */
const PLAN_MODE_DISPLAY: Record<string, { name: string; description: string }> = {
  EnterPlanMode: {
    name: "进入规划模式",
    description: "Agent 请求进入规划模式，将在只读模式下探索代码库并设计实现方案。",
  },
  ExitPlanMode: {
    name: "规划方案审批",
    description: "Agent 已完成方案规划，请审阅上方的规划内容后决定是否批准执行。",
  },
};

export function resolvePlanModeDisplay(
  toolName: string,
  fallbackInput: string,
  planContent?: string,
  displayName?: string,
): { name: string; description: string } {
  const mapped = PLAN_MODE_DISPLAY[toolName];
  if (mapped) {
    const description = (toolName === "ExitPlanMode" && planContent) ? planContent : mapped.description;
    return { name: mapped.name, description };
  }
  return { name: displayName || toolName, description: fallbackInput };
}

function formatPermissionInput(toolInput?: Record<string, unknown>): string {
  if (!toolInput) return "";
  return JSON.stringify(toolInput, null, 2);
}

/** Messages controller interface — platform-agnostic subset */
export interface MessagesController {
  messagesRef: { current: MessageItem[] };
  addMessage: (message: MessageItemInput) => number;
  updateMessageAt: (index: number, updater: (msg: MessageItem) => MessageItem) => void;
  setMessages?: (messages: MessageItemInput[], options?: { scrollToBottom?: boolean }) => void;
  triggerScroll: () => void;
}

function runtimeStatusText(status: Extract<MessageItem, { type: "runtime_status" }>["status"]): string {
  switch (status) {
    case "sending":
      return "正在发送消息";
    case "queued":
      return "已进入队列";
    case "running":
      return "正在思考";
    case "waiting_hand":
      return "正在准备工作区";
    case "waiting_approval":
      return "等待授权";
    case "waiting_user":
      return "等待补充信息";
    case "reconnecting":
      return "正在恢复连接";
    default:
      return "正在处理";
  }
}

export function upsertRuntimeStatusMessage(
  msg: MessagesController,
  status: Extract<MessageItem, { type: "runtime_status" }>["status"],
  options: { content?: string; streamId?: string; runId?: string } = {},
): void {
  const msgs = msg.messagesRef.current;
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === "runtime_status") {
      idx = i;
      break;
    }
    if (msgs[i].type === "text" || msgs[i].type === "thinking" || msgs[i].type === "tool_use") break;
  }
  const patch = {
    status,
    content: options.content ?? runtimeStatusText(status),
    ...(options.streamId ? { streamId: options.streamId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    streaming: true,
    timestamp: Date.now(),
  } satisfies Omit<Extract<MessageItem, { type: "runtime_status" }>, "id" | "type">;
  if (idx >= 0) {
    msg.updateMessageAt(idx, (message) =>
      message.type === "runtime_status" ? { ...message, ...patch } : message
    );
    return;
  }
  msg.addMessage({ type: "runtime_status", ...patch });
}

export function removeRuntimeStatusMessages(msg: MessagesController): void {
  const msgs = msg.messagesRef.current;
  if (!msgs.some((message) => message.type === "runtime_status")) return;
  if (msg.setMessages) {
    msg.setMessages(msgs.filter((message) => message.type !== "runtime_status"), { scrollToBottom: false });
    return;
  }
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].type === "runtime_status") {
      msg.updateMessageAt(i, (message) =>
        message.type === "runtime_status" ? { ...message, streaming: false } : message
      );
    }
  }
}

function findToolUseIndex(msgs: MessageItem[], toolId?: string, toolName?: string): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const message = msgs[i];
    if (message.type !== "tool_use") continue;
    if (toolId && message.toolId === toolId) return i;
    if (!toolId && toolName && message.toolName === toolName && !message.resultReady) return i;
  }
  return -1;
}

/** Mark all running subagents as completed */
export function finalizeRunningSubagents(msg: MessagesController): void {
  const msgs = msg.messagesRef.current;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.type === "subagent" && m.status === "running") {
      msg.updateMessageAt(i, (prev) =>
        prev.type === "subagent" ? { ...prev, status: "completed" as const } : prev
      );
    }
  }
}

/** Mark any half-open streaming text/thinking/tool block as completed. */
export function finalizeStreamingMessages(msg: MessagesController): void {
  const msgs = msg.messagesRef.current;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if ("streaming" in m && m.streaming) {
      msg.updateMessageAt(i, (prev) => {
        if (prev.type === "thinking" && typeof prev.startedAt === "number" && typeof prev.durationMs !== "number") {
          return { ...prev, streaming: false, durationMs: Math.max(0, Date.now() - prev.startedAt) };
        }
        return "streaming" in prev ? { ...prev, streaming: false } : prev;
      });
    }
    if (m.type === "tool_use" && m.executionStatus === "running") {
      msg.updateMessageAt(i, (prev) =>
        prev.type === "tool_use" ? { ...prev, executionStatus: prev.resultReady ? "completed" : "pending" } : prev
      );
    }
  }
  removeRuntimeStatusMessages(msg);
}

/** WS event processing context */
export interface WsProcessingContext {
  msg: MessagesController;
  session: {
    setIsNewSession: (v: boolean) => void;
    setSessionId: (id: string | null) => void;
    loadSessions: () => Promise<void>;
    updateSessionTitle: (sessionId: string, title: string) => void;
    updateSessionMeta: (sessionId: string, patch: { preview?: string; updatedAtMs?: number; title?: string }) => void;
    removeSession: (sessionId: string) => void;
    upsertSession?: (session: { sessionId: string; title?: string; preview?: string; updatedAtMs: number; model?: string; username?: string }) => void;
  };
  selectedModelRef: { current: string | null };
  voiceCallbackRef: { current: ((key: string, text: string, voice?: string, speed?: number) => void) | undefined };
  streamIdRef: { current: string | null };
  runIdRef?: { current: string | null };
  lastEventIdRef: { current: number | null };
  userMsgIndex: number;
  /** Platform storage callback for persisting model selection */
  onModelPersist?: (sessionId: string, model: string) => void;
  /** 当前会话所属用户（admin 查看其他用户会话时需要，用于文件路径解析） */
  sessionOwnerRef?: { current: string | undefined };
  /** 消息可靠性协议回调（2026-04-18 新增）—— 用于 outbox 状态机更新 */
  onChatAck?: (clientMsgId: string) => void;
  onChatRejected?: (clientMsgId: string, reasonCode: string, reason: string) => void;
  /** done 事件（可能带 error）时被调用，用于同步 outbox 终态 */
  onChatDone?: (clientMsgId: string | undefined, error: string | undefined) => void;
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
}

/** Process a single WS event. Returns 'done' or 'buffer_overflow' for special states. */
export function processWsEvent(
  data: WsEvent,
  ctx: WsProcessingContext,
  block: WsBlockState,
  latestSessionId: { value: string | null },
  activeSessionId: string | null,
): 'done' | 'buffer_overflow' | void {
  const { msg, session, selectedModelRef, voiceCallbackRef, streamIdRef } = ctx;

  if (data.type === "stream_id") {
    streamIdRef.current = data.streamId;
    if (ctx.runIdRef) ctx.runIdRef.current = data.runId ?? null;
    upsertRuntimeStatusMessage(msg, "queued", {
      streamId: data.streamId,
      ...(data.runId ? { runId: data.runId } : {}),
    });
    // 优先按 client_msg_id 精准定位（支持多条 pending 并发），回退到 userMsgIndex 兼容老路径
    const msgs = msg.messagesRef.current;
    let targetIdx = -1;
    if (data.client_msg_id) {
      targetIdx = findUserMsgIndexByClientId(msgs, data.client_msg_id);
    }
    if (targetIdx < 0 && ctx.userMsgIndex >= 0) {
      targetIdx = ctx.userMsgIndex;
    }
    if (targetIdx >= 0) {
      msg.updateMessageAt(targetIdx, (m) =>
        m.type === "user" && m.status === "pending" ? { ...m, status: "sent" as const } : m
      );
    }
    return;
  }

  if (data.type === "chat_ack") {
    // 通知上层 outbox：服务端已接收
    ctx.onChatAck?.(data.client_msg_id);
    return;
  }

  if (data.type === "chat_rejected") {
    removeRuntimeStatusMessages(msg);
    const msgs = msg.messagesRef.current;
    const idx = findUserMsgIndexByClientId(msgs, data.client_msg_id);
    if (idx >= 0) {
      msg.updateMessageAt(idx, (m) => {
        if (m.type === "user") {
          return { ...m, status: "failed" as const, failedReason: data.reason };
        }
        if (m.type === "user-voice") {
          return { ...m, status: "failed" as const, failedReason: data.reason };
        }
        return m;
      });
    }
    ctx.onChatRejected?.(data.client_msg_id, data.reason_code, data.reason);
    return;
  }

  if (data.type === "user_message") {
    // 去重：优先按 client_msg_id（精准），回退 content（兼容老 transcript）
    const msgs = msg.messagesRef.current;
    const isDup = msgs.some(m => {
      if (m.type !== "user") return false;
      if (data.client_msg_id && 'clientMsgId' in m && m.clientMsgId) {
        return m.clientMsgId === data.client_msg_id;
      }
      return m.content === data.content;
    });
    if (!isDup) {
      msg.addMessage({
        type: "user",
        content: data.content,
        ...(data.attachments ? { attachments: data.attachments } : {}),
        timestamp: data.timestamp,
        ...(data.client_msg_id ? { clientMsgId: data.client_msg_id } : {}),
      });
    }
    return;
  }

  if (data.type === "session") {
    const newSessionId = data.sessionId;
    latestSessionId.value = newSessionId;
    session.setIsNewSession(false);
    session.setSessionId(newSessionId);
    if (selectedModelRef.current && newSessionId) {
      ctx.onModelPersist?.(newSessionId, selectedModelRef.current);
    }
    if (ctx.session.upsertSession && newSessionId) {
      ctx.session.upsertSession({
        sessionId: newSessionId,
        updatedAtMs: Date.now(),
        ...(selectedModelRef.current ? { model: selectedModelRef.current } : {}),
      });
    }
    if (!activeSessionId) {
      void session.loadSessions();
    }
    return;
  }

  if (data.type === "block_start") {
    removeRuntimeStatusMessages(msg);
    if (block.currentBlockIndex >= 0) {
      msg.updateMessageAt(block.currentBlockIndex, (message) => {
        if (message.type === "thinking" && typeof message.startedAt === "number" && typeof message.durationMs !== "number") {
          return { ...message, streaming: false, durationMs: Math.max(0, Date.now() - message.startedAt) };
        }
        return "streaming" in message ? { ...message, streaming: false } : message;
      });
    }
    block.currentBlockType = data.blockType;
    if (data.blockType === "thinking") {
      block.currentBlockIndex = msg.addMessage({ type: "thinking", content: "", streaming: true, startedAt: Date.now() });
    } else if (data.blockType === "text") {
      const owner = ctx.sessionOwnerRef?.current;
      block.currentBlockIndex = msg.addMessage({ type: "text", content: "", streaming: true, ...(owner ? { owner } : {}), timestamp: Date.now() });
    } else if (data.blockType === "tool_use") {
      // 独立卡片工具不产生通用 tool_use 骨架。currentBlockIndex 保持 -1，
      // 让 tool_input / block_end 也自动跳过。
      if (isDedicatedToolName(data.toolName)) {
        return;
      }
      const existingIdx = findToolUseIndex(msg.messagesRef.current, data.toolId, data.toolName);
      if (existingIdx >= 0) {
        block.currentBlockIndex = existingIdx;
        msg.updateMessageAt(existingIdx, (message) =>
          message.type === "tool_use"
            ? {
                ...message,
                toolName: data.toolName || message.toolName || "unknown",
                toolId: data.toolId || message.toolId || "",
                toolInput: "",
                streaming: true,
                executionStatus: message.executionStatus ?? "pending",
              }
            : message
        );
      } else {
        block.currentBlockIndex = msg.addMessage({
          type: "tool_use", toolName: data.toolName || "unknown",
          toolInput: "", toolId: data.toolId || "", streaming: true,
          executionStatus: "pending",
        });
      }
    }
    return;
  }

  if (data.type === "thinking") {
    if (block.currentBlockType === "thinking" && block.currentBlockIndex >= 0) {
      msg.updateMessageAt(block.currentBlockIndex, (message) =>
        message.type === "thinking" ? { ...message, content: message.content + (data.content || "") } : message
      );
    }
    return;
  }

  if (data.type === "text") {
    if (block.currentBlockType === "text" && block.currentBlockIndex >= 0) {
      msg.updateMessageAt(block.currentBlockIndex, (message) =>
        message.type === "text" ? { ...message, content: message.content + (data.content || "") } : message
      );
    }
    return;
  }

  if (data.type === "tool_input") {
    if (block.currentBlockType === "tool_use" && block.currentBlockIndex >= 0) {
      msg.updateMessageAt(block.currentBlockIndex, (message) =>
        message.type === "tool_use" ? { ...message, toolInput: message.toolInput + (data.content || "") } : message
      );
    }
    return;
  }

  if (data.type === "block_end") {
    if (block.currentBlockIndex >= 0) {
      const resolvedToolName = data.toolName;
      msg.updateMessageAt(block.currentBlockIndex, (message) => {
        if (!("streaming" in message)) return message;
        if (resolvedToolName && message.type === "tool_use" && message.toolName !== resolvedToolName) {
          return {
            ...message,
            streaming: false,
            toolName: resolvedToolName,
            executionStatus: message.executionStatus ?? "pending",
          };
        }
        if (message.type === "tool_use") {
          return { ...message, streaming: false, executionStatus: message.executionStatus ?? "pending" };
        }
        if (message.type === "thinking" && typeof message.startedAt === "number" && typeof message.durationMs !== "number") {
          return { ...message, streaming: false, durationMs: Math.max(0, Date.now() - message.startedAt) };
        }
        return { ...message, streaming: false };
      });
    }
    block.currentBlockIndex = -1;
    block.currentBlockType = null;
    return;
  }

  if (data.type === "tool_execution") {
    // 独立卡片工具的 invocation 可能被旧 buffer 投影成 tool_execution；这里兜底跳过。
    // toolName 只在 phase=started/completed 里携带，progress 时靠 toolId 找已有骨架，
    // 独立卡片工具本就没有骨架，findToolUseIndex 找不到会走 addMessage —— 一并挡住。
    if (isDedicatedToolName(data.toolName)) {
      removeRuntimeStatusMessages(msg);
      return;
    }
    removeRuntimeStatusMessages(msg);
    const toolId = data.toolId || "";
    const toolName = data.toolName || "unknown";
    const msgs = msg.messagesRef.current;
    const existingIdx = findToolUseIndex(msgs, toolId, data.toolName);
    const executionStatus = data.phase === "completed"
      ? data.status === "error"
        ? "failed"
        : data.status === "cancelled"
          ? "cancelled"
          : "completed"
      : "running";
    const patch = {
      toolName,
      toolId,
      executionStatus,
      streaming: false,
      ...(data.invocationId ? { invocationId: data.invocationId } : {}),
      ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
      ...(data.content ? { lastProgress: data.content } : {}),
      ...(data.error ? { error: data.error } : {}),
    } satisfies Partial<Extract<MessageItem, { type: "tool_use" }>>;
    if (existingIdx >= 0) {
      msg.updateMessageAt(existingIdx, (message) =>
        message.type === "tool_use" ? { ...message, ...patch } : message
      );
      return;
    }
    msg.addMessage({
      type: "tool_use",
      toolInput: "",
      ...patch,
    });
    return;
  }

  if (data.type === "error") {
    removeRuntimeStatusMessages(msg);
    const owner = ctx.sessionOwnerRef?.current;
    msg.addMessage({ type: "text", content: `Error: ${data.message || "Unknown error"}`, ...(owner ? { owner } : {}) });
    return;
  }

  if (data.type === "tool_result") {
    // 独立卡片工具的结果由各自卡片呈现，兜底跳过。
    if (isDedicatedToolName(data.toolName)) {
      removeRuntimeStatusMessages(msg);
      return;
    }
    removeRuntimeStatusMessages(msg);
    const toolId = data.toolId || "";
    const msgs = msg.messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.type === "tool_use" && m.toolId === toolId) {
        msg.updateMessageAt(i, (prev) =>
          prev.type === "tool_use"
            ? {
                ...prev,
                result: data.result || "",
                resultReady: true,
                executionStatus: prev.executionStatus === "cancelled"
                  ? "cancelled"
                  : data.isError
                    ? "failed"
                    : prev.executionStatus === "failed"
                      ? "failed"
                      : "completed",
              }
            : prev
        );
        return;
      }
    }
    msg.addMessage({
      type: "tool_result", toolName: data.toolName || "unknown",
      result: data.result || "", toolId,
    });
    return;
  }

  if (data.type === "permission_request") {
    removeRuntimeStatusMessages(msg);
    const { name, description } = resolvePlanModeDisplay(
      data.toolName, formatPermissionInput(data.toolInput), data.planContent, data.displayName,
    );
    msg.addMessage({
      type: "permission_request", interactionId: data.interactionId,
      toolName: name, toolInput: description, status: "pending",
    });
    return;
  }

  if (data.type === "ask_user") {
    removeRuntimeStatusMessages(msg);
    msg.addMessage({
      type: "ask_user", interactionId: data.interactionId,
      questions: data.questions, status: "pending",
    });
    return;
  }

  if (data.type === "buffer_overflow") {
    console.warn('[WS] Buffer overflow: some events were lost, refreshing session');
    return 'buffer_overflow';
  }

  if (data.type === "subagent_start") {
    removeRuntimeStatusMessages(msg);
    const msgs = msg.messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const current = msgs[i];
      if (current.type === "subagent" && current.toolId === data.toolId) {
        msg.updateMessageAt(i, (message) =>
          message.type === "subagent"
            ? {
                ...message,
                agentType: data.agentType,
                status: "running" as const,
                ...(data.childSessionId ? { childSessionId: data.childSessionId } : {}),
                ...(data.childRunId ? { childRunId: data.childRunId } : {}),
                ...(data.model ? { model: data.model } : {}),
              }
            : message
        );
        return;
      }
      if (current.type === "tool_use" && current.toolId === data.toolId) {
        msg.updateMessageAt(i, (message) => ({
          id: message.id,
          type: "subagent",
          toolId: data.toolId,
          agentType: data.agentType,
          status: "running" as const,
          ...(data.childSessionId ? { childSessionId: data.childSessionId } : {}),
          ...(data.childRunId ? { childRunId: data.childRunId } : {}),
          ...(data.model ? { model: data.model } : {}),
        }));
        return;
      }
    }
    msg.addMessage({
      type: "subagent",
      toolId: data.toolId,
      agentType: data.agentType,
      status: "running",
      ...(data.childSessionId ? { childSessionId: data.childSessionId } : {}),
      ...(data.childRunId ? { childRunId: data.childRunId } : {}),
      ...(data.model ? { model: data.model } : {}),
    });
    return;
  }

  if (data.type === "subagent_end") {
    const msgs = msg.messagesRef.current;
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.type === "subagent" && m.toolId === data.toolId) { idx = i; break; }
    }
    if (idx >= 0) {
      msg.updateMessageAt(idx, (m) =>
        m.type === "subagent" ? {
          ...m,
          status: data.status ?? "completed",
          ...(data.agentType ? { agentType: data.agentType } : {}),
          ...(data.childSessionId ? { childSessionId: data.childSessionId } : {}),
          ...(data.childRunId ? { childRunId: data.childRunId } : {}),
          ...(data.model ? { model: data.model } : {}),
          ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
          ...(typeof data.totalTokens === "number" ? { totalTokens: data.totalTokens } : {}),
          ...(typeof data.toolUseCount === "number" ? { toolUseCount: data.toolUseCount } : {}),
          ...(typeof data.turnCount === "number" ? { turnCount: data.turnCount } : {}),
          ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
          ...(data.resultPreview ? { resultPreview: data.resultPreview } : {}),
        } : m
      );
    } else if (data.agentType) {
      msg.addMessage({
        type: "subagent",
        toolId: data.toolId,
        agentType: data.agentType,
        status: data.status ?? "completed",
        ...(data.childSessionId ? { childSessionId: data.childSessionId } : {}),
        ...(data.childRunId ? { childRunId: data.childRunId } : {}),
        ...(data.model ? { model: data.model } : {}),
        ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
        ...(typeof data.totalTokens === "number" ? { totalTokens: data.totalTokens } : {}),
        ...(typeof data.toolUseCount === "number" ? { toolUseCount: data.toolUseCount } : {}),
        ...(typeof data.turnCount === "number" ? { turnCount: data.turnCount } : {}),
        ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
        ...(data.resultPreview ? { resultPreview: data.resultPreview } : {}),
      });
    }
    return;
  }

  if (data.type === "done") {
    removeRuntimeStatusMessages(msg);
    finalizeStreamingMessages(msg);
    block.currentBlockIndex = -1;
    block.currentBlockType = null;
    finalizeRunningSubagents(msg);
    // 若携带 error（SDK/Runtime 失败路径），把对应 user 气泡翻 failed。
    // durable runtime 的终态事件可能没有 client_msg_id，回退到当前发送索引 / 最近一条未失败的用户消息，
    // 避免前端只清 loading 却没有任何失败提示。
    if (data.error) {
      const msgs = msg.messagesRef.current;
      let idx = data.client_msg_id ? findUserMsgIndexByClientId(msgs, data.client_msg_id) : -1;
      if (idx < 0 && ctx.userMsgIndex >= 0) idx = ctx.userMsgIndex;
      if (idx < 0) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if ((m.type === "user" || m.type === "user-voice") && m.status !== "failed") {
            idx = i;
            break;
          }
        }
      }
      // 用户侧只看通俗文案;原始 error 留在 server.log + PG runtime_events 供排查。
      const userFacing = formatRuntimeFailureMessage(data.error);
      const isBillingBlock = isInsufficientCreditsFailure(data.error);
      if (isBillingBlock) {
        // 余额门禁是可预期的账户状态，消息已经成功送达，不能把用户气泡染成“发送失败”。
        if (idx >= 0) {
          msg.updateMessageAt(idx, (m) => {
            if (m.type === "user" || m.type === "user-voice") {
              const next = { ...m, status: "sent" as const };
              delete next.failedReason;
              return next;
            }
            return m;
          });
        }
        // 平台无关层保留文本兜底；Web 随后会把它升级为独立的积分提示卡。
        const last = msg.messagesRef.current[msg.messagesRef.current.length - 1];
        if (!((last?.type === "text" || last?.type === "system-error") && last.content === userFacing)) {
          const owner = ctx.sessionOwnerRef?.current;
          msg.addMessage({ type: "text", content: userFacing, ...(owner ? { owner } : {}), timestamp: Date.now() });
        }
      } else if (idx >= 0) {
        msg.updateMessageAt(idx, (m) => {
          if (m.type === "user") {
            return { ...m, status: "failed" as const, failedReason: userFacing };
          }
          if (m.type === "user-voice") {
            return { ...m, status: "failed" as const, failedReason: userFacing };
          }
          return m;
        });
      } else {
        const owner = ctx.sessionOwnerRef?.current;
        msg.addMessage({ type: "text", content: userFacing, ...(owner ? { owner } : {}), timestamp: Date.now() });
      }
    }
    ctx.onChatDone?.(data.client_msg_id, data.error);
    return 'done';
  }

  if (data.type === "title_updated") {
    ctx.session.updateSessionTitle(data.sessionId, data.title);
    return;
  }

  if (data.type === "session_deleted") {
    ctx.session.removeSession(data.sessionId);
    return;
  }

  if (data.type === "session_updated") {
    if (data.isNew && ctx.session.upsertSession) {
      const hasDisplayContent = Boolean(data.title || data.preview);
      if (hasDisplayContent) {
        // 其他设备创建的新会话：仅在已有可展示内容时直接插入本地列表
        ctx.session.upsertSession({
          sessionId: data.sessionId,
          title: data.title,
          preview: data.preview,
          updatedAtMs: data.updatedAtMs,
          model: data.model,
          username: data.username,
        });
      } else {
        // 尚未稳定可展示的新会话，回退到当前视角的服务端真值，避免插入“新会话”占位项
        void ctx.session.loadSessions();
      }
    } else {
      // 已有会话 → 本地 patch
      ctx.session.updateSessionMeta(data.sessionId, {
        preview: data.preview,
        updatedAtMs: data.updatedAtMs,
        ...(data.title !== undefined ? { title: data.title } : {}),
      });
    }
    return;
  }

  if (data.type === "voice_transcribed") {
    const msgs = msg.messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.type === "user-voice" && (m.status === "transcribing" || m.status === "uploading")) {
        msg.updateMessageAt(i, (prev) =>
          prev.type === "user-voice"
            ? { ...prev, transcribedText: data.text, status: data.error ? 'failed' : 'sent' }
            : prev
        );
        break;
      }
    }
    return;
  }

  if (data.type === "file_download") {
    msg.addMessage({
      type: "file_download",
      fileName: data.fileName,
      fileType: data.fileType,
      filePath: data.filePath,
      fileSize: data.fileSize,
      ...(data.owner ? { owner: data.owner } : {}),
    });
    return;
  }

  if (data.type === "artifact_created") {
    // 兼容旧 artifact_created 事件：artifactId 是主 key,filePath 保留 sourcePath 作
    // 展示辅助（下载路径实际走 /api/artifacts/:id/read-url,不依赖 filePath）。
    msg.addMessage({
      type: "file_download",
      fileName: data.fileName,
      fileType: data.mimeType ?? "",
      filePath: data.sourcePath ?? data.fileName,
      fileSize: data.sizeBytes ?? 0,
      artifactId: data.artifactId,
      artifactKind: data.kind,
      ...(data.mimeType ? { mimeType: data.mimeType } : {}),
      ...(data.owner ? { owner: data.owner } : {}),
    });
    return;
  }

  if (data.type === "voice") {
    const marker = { text: data.text, voice: data.voice, speed: data.speed };
    if (data.standalone) {
      const msgs = msg.messagesRef.current;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.type === "voice") {
        const lastIdx = msgs.length - 1;
        const vi = lastMsg.voiceMarkers.length;
        msg.updateMessageAt(lastIdx, (m) =>
          m.type === "voice" ? { ...m, voiceMarkers: [...m.voiceMarkers, marker] } : m
        );
        const voiceKey = `voice-${lastIdx}-${vi}`;
        voiceCallbackRef.current?.(voiceKey, data.text, data.voice, data.speed);
      } else {
        const newIdx = msg.addMessage({ type: "voice", voiceMarkers: [marker] });
        const voiceKey = `voice-${newIdx}-0`;
        voiceCallbackRef.current?.(voiceKey, data.text, data.voice, data.speed);
      }
    } else {
      const msgs = msg.messagesRef.current;
      let textIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].type === "text") { textIdx = i; break; }
      }
      if (textIdx >= 0) {
        const textMsg = msgs[textIdx];
        const vi = textMsg.type === "text" ? (textMsg.voiceMarkers?.length ?? 0) : 0;
        msg.updateMessageAt(textIdx, (m) => {
          if (m.type === "text") {
            const existing = m.voiceMarkers || [];
            return { ...m, voiceMarkers: [...existing, marker] };
          }
          return m;
        });
        const voiceKey = `voice-${textIdx}-${vi}`;
        voiceCallbackRef.current?.(voiceKey, data.text, data.voice, data.speed);
      }
    }
    return;
  }

  if (data.type === "interaction_resolved") {
    const msgs = msg.messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if ('interactionId' in m && (m as Record<string, unknown>).interactionId === data.interactionId) {
        if (m.type === "permission_request" && m.status === "pending") {
          msg.updateMessageAt(i, (prev) =>
            prev.type === "permission_request" ? { ...prev, status: "allowed" as const } : prev
          );
        } else if (m.type === "ask_user" && m.status === "pending") {
          msg.updateMessageAt(i, (prev) =>
            prev.type === "ask_user" ? { ...prev, status: "answered" as const } : prev
          );
        }
        break;
      }
    }
    return;
  }

  if (data.type === "pending_interactions") {
    const existingIds = new Set(
      msg.messagesRef.current
        .filter(m => 'interactionId' in m && m.interactionId)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map(m => (m as any).interactionId as string)
    );
    for (const interaction of data.interactions) {
      if (existingIds.has(interaction.interactionId)) continue;
      if (interaction.type === 'permission_request' && interaction.toolName) {
        const { name, description } = resolvePlanModeDisplay(
          interaction.toolName, formatPermissionInput(interaction.toolInput), interaction.planContent, interaction.displayName,
        );
        msg.addMessage({
          type: "permission_request", interactionId: interaction.interactionId,
          toolName: name, toolInput: description, status: "pending",
        });
      } else if (interaction.type === 'ask_user' && interaction.questions) {
        msg.addMessage({
          type: "ask_user", interactionId: interaction.interactionId,
          questions: interaction.questions, status: "pending",
        });
      }
    }
    return;
  }
}
