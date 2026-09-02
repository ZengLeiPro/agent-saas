import type { InteractionResponse } from '../agent/types.js';
import type { InboundMessage } from '../types/index.js';
import type { RunRecord, RunStatus } from './runStore.js';
import type { RuntimeSessionRecord } from './sessionCatalog.js';
import type { PlatformEvent } from './types.js';
import { parseCanonicalChatSubmission } from '@agent/shared';

export function isTerminalRunStatus(status: RunStatus | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned';
}


/**
 * wake 路径事件加载白名单（内存瘦身，避免把大事件载入 Node）。
 * 收窄前必须核对下游消费者：
 * - cancelRequested 判断依赖 run_cancel_requested；
 * - pending approval/interaction 恢复依赖 approval_* / interaction_*；
 * - resolveWakePrompt 依赖 user_message 判断“当前 run 是否已持久化用户消息”（防 wake 重复重放）；
 * - restoreWakeMessage 依赖 user_message_submitted / user_message 兜底恢复原始 prompt 内容。
 * 2026-08-02 b58e63d 收窄时漏掉 user_message*，导致 drain handoff 后重复写 user_message（会话 18b40ab1）。
 */
export const WAKE_EVENT_LIST_TYPES = [
  'run_cancel_requested',
  'approval_requested',
  'approval_resolved',
  'interaction_requested',
  'interaction_resolved',
  'user_message',
  'user_message_submitted',
] as const satisfies readonly PlatformEvent['type'][];

/**
 * 插话回退 run 的隐藏唤醒提示（2026-08-04 BUG-4）：user_message 已在上下文里
 *（drain 时投影），只需指示模型响应它；明确禁止继续上一个（已取消的）任务。
 */
export const INTERJECTION_FALLBACK_PROMPT =
  'The previous run in this session ended before it could address the latest user message. '
  + 'That message is already present as the last user message in the durable session context. '
  + 'Respond to that message now. If the previous run was cancelled, do NOT resume or continue its task '
  + 'unless the message explicitly asks for it.';

export const HIDDEN_WAKE_CONTINUE_PROMPT =
  'Continue the interrupted managed-agent run from the durable session context. '
  + 'Do not treat this as a new user request. Do not restart completed work; continue from the latest completed event.';

export function resolveWakePrompt(
  run: RunRecord,
  events: PlatformEvent[],
  session: RuntimeSessionRecord,
): { message: InboundMessage; recordUserMessage: boolean } {
  const metadataMessage = isWakeMessage(run.metadata?.wakeMessage) ? run.metadata.wakeMessage : null;
  if (metadataMessage?.metadata?.hiddenContinuation === true) {
    return { message: restoreWakeMessage(run, events, session), recordUserMessage: false };
  }
  const hasOwnPersistedUserMessage = events.some((event) => (
    event.type === 'user_message'
    && event.sessionId === run.sessionId
    && event.runId === run.runId
  ));
  const hasInterjectionPersistedUserMessage = events.some((event) => (
    event.type === 'user_message'
    && event.sessionId === run.sessionId
    && event.interjectionSourceRunId === run.runId
  ));
  if (!hasOwnPersistedUserMessage && !hasInterjectionPersistedUserMessage) {
    return { message: restoreWakeMessage(run, events, session), recordUserMessage: true };
  }
  // 插话回退分支（2026-08-04 BUG-4 修复）：本 run 是被 drain 过（user_message 已投影）
  // 但未被 claim 的插话 source——目标 run 在 drain→claim 窗口内被取消/终态。此时绝不能
  // 用「继续被中断的运行」提示：目标 run 多半是用户主动喊停的，那个提示会让模型接着做
  // 用户刚取消的任务。改用明确指令：响应上下文中最后那条用户消息本身。
  if (!hasOwnPersistedUserMessage && hasInterjectionPersistedUserMessage) {
    return {
      message: {
        channel: 'web',
        chatId: run.sessionId,
        content: INTERJECTION_FALLBACK_PROMPT,
        senderId: session.userId ?? run.userId,
        senderName: session.username,
        metadata: {
          schedulerWake: true,
          originalRunId: run.runId,
          hiddenContinuation: true,
          interjectionFallback: true,
        },
      },
      recordUserMessage: false,
    };
  }
  return {
    message: {
      channel: 'web',
      chatId: run.sessionId,
      content: HIDDEN_WAKE_CONTINUE_PROMPT,
      senderId: session.userId ?? run.userId,
      senderName: session.username,
      metadata: {
        schedulerWake: true,
        originalRunId: run.runId,
        hiddenContinuation: true,
      },
    },
    recordUserMessage: false,
  };
}

export function isResumeApprovalMetadata(value: unknown): value is { approvalId: string; response: InteractionResponse } {
  if (!value || typeof value !== 'object') return false;
  const obj = value as { approvalId?: unknown; response?: unknown; consumedAt?: unknown; resumeApprovalConsumedAt?: unknown };
  if (typeof obj.consumedAt === 'string' || typeof obj.resumeApprovalConsumedAt === 'string') return false;
  if (typeof obj.approvalId !== 'string' || !obj.response || typeof obj.response !== 'object') return false;
  const response = obj.response as { allow?: unknown };
  return typeof response.allow === 'boolean';
}

export function isResumeInteractionMetadata(value: unknown): value is { interactionId: string; response: InteractionResponse } {
  if (!value || typeof value !== 'object') return false;
  const obj = value as { interactionId?: unknown; response?: unknown; consumedAt?: unknown; resumeInteractionConsumedAt?: unknown };
  if (typeof obj.consumedAt === 'string' || typeof obj.resumeInteractionConsumedAt === 'string') return false;
  if (typeof obj.interactionId !== 'string' || !obj.response || typeof obj.response !== 'object') return false;
  return true;
}

export function isConsumedResume(
  metadata: Record<string, unknown>,
  prefix: 'resumeApprovalConsumed' | 'resumeInteractionConsumed',
  id: string,
): boolean {
  return typeof metadata[`${prefix}At`] === 'string'
    && metadata[`${prefix}Id`] === id;
}

export function restoreWakeMessage(
  run: RunRecord,
  events: PlatformEvent[],
  session: RuntimeSessionRecord,
): InboundMessage {
  const metadataMessage = isWakeMessage(run.metadata?.wakeMessage) ? run.metadata.wakeMessage : null;
  const parsedSubmission = parseCanonicalChatSubmission(run.metadata?.chatSubmission);
  const canonicalSubmission = parsedSubmission.ok ? parsedSubmission.value : null;
  const submitted = [...events].reverse().find((event): event is Extract<PlatformEvent, { type: 'user_message_submitted' }> => (
    event.type === 'user_message_submitted'
    && (!event.sessionId || event.sessionId === run.sessionId)
  ));
  const priorUserMessage = [...events].reverse().find((event): event is Extract<PlatformEvent, { type: 'user_message' }> => (
    event.type === 'user_message'
    && event.sessionId === run.sessionId
    && event.runId === run.runId
  ));
  return {
    channel: 'web',
    chatId: metadataMessage?.chatId ?? run.sessionId,
    content: metadataMessage?.content ?? canonicalSubmission?.text ?? submitted?.content ?? priorUserMessage?.content ?? 'Continue the interrupted managed-agent run from durable session context.',
    senderId: metadataMessage?.senderId ?? session.userId ?? run.userId,
    senderName: metadataMessage?.senderName ?? session.username,
    attachments: metadataMessage?.attachments ?? canonicalSubmission?.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      originalName: attachment.display.originalName,
      size: attachment.display.size ?? 0,
      mimeType: attachment.display.mimeType ?? 'application/octet-stream',
      isImage: attachment.display.isImage ?? false,
    })),
    metadata: {
      ...(metadataMessage?.metadata ?? {}),
      schedulerWake: true,
      originalRunId: run.runId,
    },
  };
}

export function isWakeMessage(value: unknown): value is {
  channel?: string;
  chatId?: string;
  content: string;
  senderId?: string;
  senderName?: string;
  attachments?: InboundMessage['attachments'];
  metadata?: Record<string, unknown>;
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as { content?: unknown }).content === 'string';
}
