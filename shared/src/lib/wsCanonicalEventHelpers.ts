/** Canonical projection and safe-error helpers for the WS event processor. */
import type { WsEvent } from '../types/ws';
import { createActivityMessageProjectionState, reduceActivityMessageProjection, selectProjectedMessages } from './activityMessageProjection';
import { mapCanonicalError } from './canonicalError';
import { adaptWsEventToActivityMessageProjection } from './wsActivityMessageProjection';
import { reconcileProjectedToolMessage } from './wsToolMessageReconciliation';
import {
  findUserMsgIndexByClientId,
  type MessagesController,
  type WsBlockState,
  type WsProcessingContext,
} from './wsEventProcessorHelpers';

type RemoveRuntimeStatusMessages = (msg: MessagesController) => void;

/** Canonical modern projection path. Sparse legacy frames deliberately fall through. */
export function applyCanonicalProjection(
  data: WsEvent,
  msg: MessagesController,
  block: WsBlockState,
): boolean {
  const event = adaptWsEventToActivityMessageProjection(data);
  if (!event) return false;
  const previous = block.projectionState ?? createActivityMessageProjectionState();
  const next = reduceActivityMessageProjection(previous, event);
  block.projectionState = next;
  if (next === previous) return true;
  for (const item of selectProjectedMessages(next)) {
    if (reconcileProjectedToolMessage(item, msg, block)) continue;
    const indexById = msg.messagesRef.current.findIndex((candidate) => candidate.id === item.id);
    const index = indexById >= 0
      ? indexById
      : item.type === 'user' && item.clientMsgId
        ? findUserMsgIndexByClientId(msg.messagesRef.current, item.clientMsgId)
        : -1;
    if (index >= 0) {
      msg.updateMessageAt(index, (current) => (
        item.type === 'user' && current.type === 'user-voice'
          ? { ...current, id: item.id, status: 'sent', timestamp: item.timestamp ?? current.timestamp }
          : item
      ));
    } else {
      msg.addMessage(item);
    }
  }
  return true;
}

/** Route modern timeline frames through the canonical projection and clear transient status. */
export function applyCanonicalTimelineProjection(
  data: WsEvent,
  msg: MessagesController,
  block: WsBlockState,
  removeRuntimeStatusMessages: RemoveRuntimeStatusMessages,
): boolean {
  if (!(
    data.type === 'block_start' || data.type === 'block_end' || data.type === 'text'
    || data.type === 'thinking' || data.type === 'tool_execution' || data.type === 'tool_result'
    || data.type === 'subagent_start' || data.type === 'subagent_end' || data.type === 'moderation_outcome'
  )) return false;
  if (!applyCanonicalProjection(data, msg, block)) return false;
  removeRuntimeStatusMessages(msg);
  return true;
}

/** Apply a rejected chat terminal using only canonical, presentation-safe failure text. */
export function handleCanonicalChatRejected(
  data: Extract<WsEvent, { type: 'chat_rejected' }>,
  ctx: WsProcessingContext,
  removeRuntimeStatusMessages: RemoveRuntimeStatusMessages,
): void {
  const { msg } = ctx;
  const canonicalFailure = mapCanonicalError({
    source: 'chat_rejected',
    code: data.code,
    reasonCode: data.reason_code,
    retryAfterMs: typeof data.retryAfter === 'number' ? data.retryAfter * 1000 : undefined,
    correlationId: data.correlationId,
    legacyMessage: data.reason,
  });
  // duplicate_inflight means the server already owns processing; mark the local bubble sent.
  if (data.reason_code === 'duplicate_inflight') {
    const duplicateIndex = findUserMsgIndexByClientId(msg.messagesRef.current, data.client_msg_id);
    if (duplicateIndex >= 0) {
      msg.updateMessageAt(duplicateIndex, (message) => (
        message.type === 'user' || message.type === 'user-voice'
          ? { ...message, status: 'sent' as const }
          : message
      ));
    }
    ctx.onChatRejected?.(data.client_msg_id, data.reason_code, canonicalFailure.safeMessage);
    return;
  }
  removeRuntimeStatusMessages(msg);
  const index = findUserMsgIndexByClientId(msg.messagesRef.current, data.client_msg_id);
  if (index >= 0) {
    msg.updateMessageAt(index, (message) => (
      message.type === 'user' || message.type === 'user-voice'
        ? { ...message, status: 'failed' as const, failedReason: canonicalFailure.safeMessage }
        : message
    ));
  }
  ctx.onChatRejected?.(data.client_msg_id, data.reason_code, canonicalFailure.safeMessage);
}

/** Append a canonical WS error without retaining raw message, path, stack, or secret text. */
export function handleCanonicalWsError(
  data: Extract<WsEvent, { type: 'error' }>,
  msg: MessagesController,
  removeRuntimeStatusMessages: RemoveRuntimeStatusMessages,
): void {
  removeRuntimeStatusMessages(msg);
  const canonicalFailure = mapCanonicalError({
    source: 'ws',
    code: data.code,
    retryAfterMs: typeof data.retryAfter === 'number' ? data.retryAfter * 1000 : undefined,
    correlationId: data.correlationId,
    legacyMessage: data.message,
  });
  msg.addMessage({
    type: 'system-error',
    content: canonicalFailure.safeMessage,
    severity: 'error',
    canonicalFailure,
  });
}
