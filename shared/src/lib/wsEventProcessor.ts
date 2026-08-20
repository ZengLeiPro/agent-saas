/**
 * WS event processor — pure functions for handling WebSocket events.
 * Platform-agnostic: no browser-specific APIs.
 */

import type { MessageItem } from '../types/message';
import type { WsEvent } from '../types/ws';
import { formatRuntimeFailureMessage, isInsufficientCreditsFailure } from './runtimeErrorMessage';
import { resolveRuntimeStatusPatch, type RuntimeStatus, type RuntimeStatusOptions } from './runtimeStatusTransition';
import { normalizeToolPresentation } from './toolPresentation';
import { normalizeToolResultMetadata } from './toolResultMetadata';
import { formatPermissionInput, isDedicatedToolName, resolvePlanModeDisplay } from './wsToolDisplay';

export { resolvePlanModeDisplay } from './wsToolDisplay';

import {
  findUserMsgIndexByClientId,
  type MessagesController,
  type WsBlockState,
  type WsProcessingContext,
} from './wsEventProcessorHelpers';

export function upsertRuntimeStatusMessage(
  msg: MessagesController,
  status: RuntimeStatus,
  options: RuntimeStatusOptions = {},
): void {
  const msgs = msg.messagesRef.current;
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const candidate = msgs[i];
    if (candidate.type === "runtime_status") {
      // 状态行按 runId 归属（2026-08-04）：双方 runId 都存在且不同时不得复用——
      // 否则目标 run 的 running 会把插话的 queued 状态行原地覆盖成「正在思考」，
      // 用户误以为排队消息已开始处理。归属不同就新建一条。
      if (options.runId && candidate.runId && candidate.runId !== options.runId) break;
      idx = i;
      break;
    }
    if (candidate.type === "text" || candidate.type === "thinking" || candidate.type === "tool_use") break;
  }
  const candidate = idx >= 0 ? msgs[idx] : undefined;
  const current = candidate?.type === "runtime_status" ? candidate : undefined;
  // timestamp 参与虚拟行 key，状态切换与重复事件都不能刷新它。
  const patch = resolveRuntimeStatusPatch(current, status, options);
  if (!patch) return;
  if (idx >= 0) {
    msg.updateMessageAt(idx, (message) =>
      message.type === "runtime_status" ? { ...message, ...patch } : message
    );
    return;
  }
  msg.addMessage({ type: "runtime_status", ...patch, timestamp: Date.now() });
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

export function findToolUseIndex(msgs: MessageItem[], toolId?: string, toolName?: string): number {
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

/** 成功终态到达后，只追认当前 Run 的最后一条非空文本。 */
export function markFinalOutputMessage(
  msg: MessagesController,
  runId: string | undefined,
  userMsgIndex: number,
): void {
  if (!runId && userMsgIndex < 0) return;
  const messages = msg.messagesRef.current;
  const lowerBound = runId ? 0 : userMsgIndex + 1;
  for (let index = messages.length - 1; index >= lowerBound; index -= 1) {
    const message = messages[index];
    if (message.type !== 'text' || !message.content.trim()) continue;
    if (runId && message.runId !== runId) continue;
    msg.updateMessageAt(index, (current) => (
      current.type === 'text' ? { ...current, finalOutput: true } : current
    ));
    return;
  }
}

export {
  findUserMsgIndexByClientId,
  type MessagesController,
  type WsBlockState,
  type WsProcessingContext,
} from './wsEventProcessorHelpers';

const MAX_HANDLED_TERMINAL_KEYS = 500;

function claimTerminalEvent(data: Extract<WsEvent, { type: 'done' }>, ctx: WsProcessingContext): boolean {
  const key = data.runId
    ? `run:${data.runId}`
    : data.client_msg_id
      ? `client:${data.client_msg_id}`
      : null;
  if (!key || !ctx.handledTerminalKeysRef) return true;

  const handled = ctx.handledTerminalKeysRef.current;
  if (handled.has(key)) return false;
  handled.add(key);
  if (handled.size > MAX_HANDLED_TERMINAL_KEYS) {
    const oldest = handled.values().next().value;
    if (oldest) handled.delete(oldest);
  }
  return true;
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
    // 防串：带 sessionId 的 stream_id 必须属于当前查看的会话。切会话/多设备场景下
    // 旧会话的接管 stream_id 不应劫持当前视图的流绑定（无 sessionId 的旧协议保持原行为）。
    if (data.sessionId) {
      const expectedSessionId = activeSessionId ?? latestSessionId.value;
      if (expectedSessionId && data.sessionId !== expectedSessionId) return;
    }
    // stream_id 只能在服务端 durable accepted 后产生；即使 chat_ack 下行丢包，也要
    // 清除前端 ACK 计时器，不能把已经执行的消息翻成“发送超时”。
    if (data.client_msg_id) ctx.onChatAck?.(data.client_msg_id);
    if (data.queued) {
      ctx.onSteeringAckQueued?.(
        data.client_msg_id,
        data.runId,
        data.targetRunId,
        data.deliveryMode,
        data.queuePosition,
      );
    }
    if (!data.queued) {
      // 插话回退为独立 run 被接管：clientMsgId 若在队列区，由上层移入时间线并
      // 返回新气泡 index（旧路径按气泡定位在终态设计下会落空、误绑当前 run 气泡）。
      const promotedIdx = ctx.onSteeringPromoted?.(data.client_msg_id, data.streamId, data.runId);
      streamIdRef.current = data.streamId;
      if (ctx.runIdRef) ctx.runIdRef.current = data.runId ?? null;
      ctx.onStreamAttached?.(data.streamId, data.runId ?? null);
      upsertRuntimeStatusMessage(msg, "queued", {
        streamId: data.streamId,
        ...(data.runId ? { runId: data.runId } : {}),
      });
      if (typeof promotedIdx === "number" && promotedIdx >= 0) {
        if (promotedIdx !== ctx.userMsgIndex) ctx.onActiveUserMsgIndexChange?.(promotedIdx);
        return;
      }
    }
    // 优先按 client_msg_id 精准定位（支持多条 pending 并发），回退到 userMsgIndex 兼容老路径
    const msgs = msg.messagesRef.current;
    let targetIdx = -1;
    if (data.client_msg_id) {
      targetIdx = findUserMsgIndexByClientId(msgs, data.client_msg_id);
    }
    if (targetIdx < 0 && ctx.userMsgIndex >= 0) {
      targetIdx = ctx.userMsgIndex;
    }
    // 接管语义仅属于非 queued 的 stream_id：服务端明确把活跃流绑到这条用户消息上，
    // 上层需同步切换 userMsgIndex，让该 run 的 done 通过 client_msg_id 归属校验。
    if (!data.queued && targetIdx >= 0 && targetIdx !== ctx.userMsgIndex) {
      ctx.onActiveUserMsgIndexChange?.(targetIdx);
    }
    if (targetIdx >= 0) {
      msg.updateMessageAt(targetIdx, (m) =>
        m.type === "user" && (m.status === "pending" || m.status === "queued")
          ? { ...m, status: data.queued ? "queued" as const : "sent" as const }
          : m
      );
    }
    return;
  }

  if (data.type === "interjection_applied") {
    if (data.sessionId) {
      const expectedSessionId = activeSessionId ?? latestSessionId.value;
      if (expectedSessionId && data.sessionId !== expectedSessionId) return;
    }
    const applied = new Set(data.clientMsgIds);
    for (let index = 0; index < msg.messagesRef.current.length; index += 1) {
      msg.updateMessageAt(index, (message) => (
        message.type === "user"
          && message.status === "queued"
          && message.clientMsgId
          && applied.has(message.clientMsgId)
          ? { ...message, status: "sent" as const }
          : message
      ));
    }
    ctx.onInterjectionApplied?.(data.sourceRunIds, data.clientMsgIds);
    return;
  }

  if (data.type === "message_queued") {
    ctx.onChatAck?.(data.clientMsgId);
    ctx.onMessageQueued?.(data);
    return;
  }

  if (data.type === "steering_queued") {
    ctx.onChatAck?.(data.clientMsgId);
    ctx.onSteeringQueued?.(data);
    return;
  }

  if (data.type === "steering_cancelled") {
    ctx.onSteeringCancelled?.(data);
    return;
  }

  if (data.type === "chat_ack") {
    // 通知上层 outbox：服务端已接收
    ctx.onChatAck?.(data.client_msg_id, data);
    return;
  }

  if (data.type === "chat_rejected") {
    // duplicate_inflight（2026-08-04 P2-9 配套）：重试复用原 clientMsgId 撞上
    // 「服务端其实已处理完」——消息确实送达过，翻已发送而不是对着一条成功的消息报错。
    if (data.reason_code === "duplicate_inflight") {
      const dupIdx = findUserMsgIndexByClientId(msg.messagesRef.current, data.client_msg_id);
      if (dupIdx >= 0) {
        msg.updateMessageAt(dupIdx, (m) => (
          (m.type === "user" || m.type === "user-voice")
            ? { ...m, status: "sent" as const }
            : m
        ));
      }
      ctx.onChatRejected?.(data.client_msg_id, data.reason_code, data.reason);
      return;
    }
    removeRuntimeStatusMessages(msg);
    // 注意：必须在 removeRuntimeStatusMessages 之后再定位（它会改变数组索引）
    const idx = findUserMsgIndexByClientId(msg.messagesRef.current, data.client_msg_id);
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
    // 防串（2026-08-04）：插话 user_message 投影带 sessionId，未 attach 放行白名单
    // 依赖这里兜底，串会话的投影不得进当前视图。
    if (data.sessionId) {
      const expectedSessionId = activeSessionId ?? latestSessionId.value;
      if (expectedSessionId && data.sessionId !== expectedSessionId) return;
    }
    // 插话被消费进时间线：清理队列区同 clientMsgId 条目（多端一致的移除信号）。
    ctx.onUserMessageProjected?.(data.client_msg_id, data.sourceRunId);
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
        status: "sent",
      });
    }
    return;
  }

  if (data.type === "session") {
    const newSessionId = data.sessionId;
    // session 会改写路由；已有当前会话时，迟到的其他会话事件只能被忽略。
    // 新会话草稿的 clientMessageId 关联由 Web hook 在进入共享处理器前校验。
    if (activeSessionId && newSessionId !== activeSessionId) return;
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

  if (data.type === "draft_reset") {
    removeRuntimeStatusMessages(msg);
    const remaining = msg.messagesRef.current.filter((message) => (
      !((message.type === "text" || message.type === "thinking") && message.draftId === data.draftId)
    ));
    if (msg.setMessages) {
      msg.setMessages(remaining, { scrollToBottom: false });
    } else {
      for (let i = 0; i < msg.messagesRef.current.length; i++) {
        msg.updateMessageAt(i, (message) => {
          if ((message.type === "text" || message.type === "thinking") && message.draftId === data.draftId) {
            return { ...message, content: "", streaming: false, draftId: undefined };
          }
          return message;
        });
      }
    }
    block.currentBlockIndex = -1;
    block.currentBlockType = null;
    upsertRuntimeStatusMessage(msg, "reconnecting", { content: "连接波动，正在恢复" });
    msg.triggerScroll();
    return;
  }

  if (data.type === "draft_commit") {
    for (let i = 0; i < msg.messagesRef.current.length; i++) {
      msg.updateMessageAt(i, (message) => {
        if ((message.type === "text" || message.type === "thinking") && message.draftId === data.draftId) {
          return { ...message, draftId: undefined };
        }
        return message;
      });
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
      block.currentBlockIndex = msg.addMessage({
        type: "thinking",
        content: "",
        streaming: true,
        startedAt: Date.now(),
        ...(data.draftId ? { draftId: data.draftId } : {}),
      });
    } else if (data.blockType === "text") {
      const owner = ctx.sessionOwnerRef?.current;
      block.currentBlockIndex = msg.addMessage({
        type: "text",
        content: "",
        streaming: true,
        ...(data.draftId ? { draftId: data.draftId } : {}),
        ...(data.runId ? { runId: data.runId } : {}),
        ...(owner ? { owner } : {}),
        timestamp: Date.now(),
      });
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
                toolId: data.toolId || message.toolId || "", ...(data.runId ? { runId: data.runId } : {}),
                toolInput: "",
                streaming: true,
                executionStatus: message.executionStatus ?? "pending",
              }
            : message
        );
      } else {
        block.currentBlockIndex = msg.addMessage({
          type: "tool_use", toolName: data.toolName || "unknown",
          toolInput: "", toolId: data.toolId || "", streaming: true, ...(data.runId ? { runId: data.runId } : {}),
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
        message.type === "text"
          ? {
              ...message,
              content: message.content + (data.content || ""),
              // 门禁拒答合成气泡携带的 event id（员工申诉入口用）
              ...(data.guardrailEventId ? { guardrailEventId: data.guardrailEventId } : {}),
            }
          : message
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
    // 与历史加载（sessionsApi）同一条不可信边界规则：WS payload 必须 normalize 后再入渲染层。
    // 这两个字段让实时观看的工具行与刷新后一致（摘要标题/✓✗ 判定/回执章不用等历史加载）。
    const presentation = normalizeToolPresentation(data.presentation) ?? undefined;
    const toolMetadata = normalizeToolResultMetadata(data.metadata) ?? undefined;
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
                ...(presentation ? { presentation } : {}),
                ...(toolMetadata ? { toolMetadata } : {}),
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
      ...(presentation ? { presentation } : {}),
    });
    return;
  }

  if (data.type === "permission_request") {
    upsertRuntimeStatusMessage(msg, "waiting_approval");
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
    upsertRuntimeStatusMessage(msg, "waiting_user");
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
    const expectedSessionId = activeSessionId ?? latestSessionId.value;
    if (data.sessionId) {
      if (expectedSessionId) {
        if (data.sessionId !== expectedSessionId) return;
      } else {
        // 草稿态（新建会话后尚未定型，activeSessionId 与 latestSessionId 都为 null）：
        // 只接受与本地在飞用户消息 client_msg_id 精确匹配的终态。否则就是别的会话晚到或
        // 重放的事件，会被写进刚清空的草稿页——2026-08-01 线上失败提示串会话的路径之一。
        const draftUserMessage = ctx.userMsgIndex >= 0
          ? msg.messagesRef.current[ctx.userMsgIndex]
          : undefined;
        const draftClientMsgId = (
          draftUserMessage
          && (draftUserMessage.type === 'user' || draftUserMessage.type === 'user-voice')
        ) ? draftUserMessage.clientMsgId : undefined;
        if (!data.client_msg_id || !draftClientMsgId || data.client_msg_id !== draftClientMsgId) return;
      }
    }
    if (data.streamId && streamIdRef.current && data.streamId !== streamIdRef.current) return;
    if (data.runId && ctx.runIdRef?.current && data.runId !== ctx.runIdRef.current) return;
    if (data.client_msg_id && ctx.userMsgIndex >= 0) {
      const currentUserMessage = msg.messagesRef.current[ctx.userMsgIndex];
      const expectedClientMsgId = (
        currentUserMessage
        && (currentUserMessage.type === 'user' || currentUserMessage.type === 'user-voice')
      ) ? currentUserMessage.clientMsgId : undefined;
      if (
        expectedClientMsgId
        && data.client_msg_id !== expectedClientMsgId
        && findUserMsgIndexByClientId(msg.messagesRef.current, data.client_msg_id) < 0
      ) return;
    }

    removeRuntimeStatusMessages(msg);
    finalizeStreamingMessages(msg);
    block.currentBlockIndex = -1;
    block.currentBlockType = null;
    finalizeRunningSubagents(msg);
    if (data.finalOutput && !data.error) {
      const matchedUserMsgIndex = data.client_msg_id
        ? findUserMsgIndexByClientId(msg.messagesRef.current, data.client_msg_id)
        : -1;
      markFinalOutputMessage(
        msg,
        data.runId,
        matchedUserMsgIndex >= 0 ? matchedUserMsgIndex : ctx.userMsgIndex,
      );
    }
    // outbox 清理保持幂等；即使同一终态先从 durable 投影到达、后从 live 路径补到
    // client_msg_id，也必须允许上层消费后到的消息标识。
    ctx.onChatDone?.(data.client_msg_id, data.error);
    if (!claimTerminalEvent(data, ctx)) return 'done';

    // 若携带 error（SDK/Runtime 失败路径），只允许精准 client_msg_id 或当前发送索引归属。
    // 绝不能扫描“最近一条未失败”的历史消息：重复终态会把整段历史逐条染红。
    if (data.error) {
      const msgs = msg.messagesRef.current;
      let idx = data.client_msg_id ? findUserMsgIndexByClientId(msgs, data.client_msg_id) : -1;
      if (idx < 0 && ctx.userMsgIndex >= 0) {
        const current = msgs[ctx.userMsgIndex];
        if (current?.type === "user" || current?.type === "user-voice") idx = ctx.userMsgIndex;
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
      } else {
        // run 已接收用户消息，只是回复在自动恢复耗尽后中断；不要把用户气泡误标成“发送失败”。
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
        // 平台无关层只留一条简短文本兜底；Web 会升级为带“继续生成”的低干扰提示。
        const last = msg.messagesRef.current[msg.messagesRef.current.length - 1];
        if (!((last?.type === "text" || last?.type === "system-error") && last.content === userFacing)) {
          const owner = ctx.sessionOwnerRef?.current;
          msg.addMessage({ type: "text", content: userFacing, ...(owner ? { owner } : {}), timestamp: Date.now() });
        }
      }
    }
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

  if (data.type === "session_read_state_changed") {
    ctx.session.updateSessionMeta(data.sessionId, {
      hasUnreadAiReply: data.hasUnreadAiReply,
    });
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
      if (interaction.type === 'permission_request') {
        upsertRuntimeStatusMessage(msg, 'waiting_approval');
      } else if (interaction.type === 'ask_user') {
        upsertRuntimeStatusMessage(msg, 'waiting_user');
      }
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
