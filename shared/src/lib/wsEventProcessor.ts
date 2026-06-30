/**
 * WS event processor — pure functions for handling WebSocket events.
 * Platform-agnostic: no browser-specific APIs.
 */

import type { MessageItem, MessageItemInput } from '../types/message';
import type { WsEvent } from '../types/ws';
import { formatRuntimeFailureMessage } from './runtimeErrorMessage';

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
  triggerScroll: () => void;
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
      msg.updateMessageAt(i, (prev) => ("streaming" in prev ? { ...prev, streaming: false } : prev));
    }
  }
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
    if (block.currentBlockIndex >= 0) {
      msg.updateMessageAt(block.currentBlockIndex, (message) =>
        "streaming" in message ? { ...message, streaming: false } : message
      );
    }
    block.currentBlockType = data.blockType;
    if (data.blockType === "thinking") {
      block.currentBlockIndex = msg.addMessage({ type: "thinking", content: "", streaming: true });
    } else if (data.blockType === "text") {
      const owner = ctx.sessionOwnerRef?.current;
      block.currentBlockIndex = msg.addMessage({ type: "text", content: "", streaming: true, ...(owner ? { owner } : {}), timestamp: Date.now() });
    } else if (data.blockType === "tool_use") {
      block.currentBlockIndex = msg.addMessage({
        type: "tool_use", toolName: data.toolName || "unknown",
        toolInput: "", toolId: data.toolId || "", streaming: true,
      });
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
          return { ...message, streaming: false, toolName: resolvedToolName };
        }
        return { ...message, streaming: false };
      });
    }
    block.currentBlockIndex = -1;
    block.currentBlockType = null;
    return;
  }

  if (data.type === "error") {
    const owner = ctx.sessionOwnerRef?.current;
    msg.addMessage({ type: "text", content: `Error: ${data.message || "Unknown error"}`, ...(owner ? { owner } : {}) });
    return;
  }

  if (data.type === "tool_result") {
    const toolId = data.toolId || "";
    const msgs = msg.messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.type === "tool_use" && m.toolId === toolId) {
        msg.updateMessageAt(i, (prev) =>
          prev.type === "tool_use"
            ? { ...prev, result: data.result || "", resultReady: true }
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
    msg.addMessage({ type: "subagent", toolId: data.toolId, agentType: data.agentType, status: "running" });
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
        m.type === "subagent" ? { ...m, status: "completed" as const } : m
      );
    }
    return;
  }

  if (data.type === "done") {
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
      if (idx >= 0) {
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
