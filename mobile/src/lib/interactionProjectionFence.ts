import type { WsEvent } from '@agent/shared';

export type RecoverableInteractionEvent = Extract<WsEvent, {
  type: 'pending_interactions' | 'permission_request' | 'ask_user' | 'interaction_resolved';
}>;

/**
 * 交互消息只允许投影到其权威会话。恢复快照/resolve 缺 sessionId 时 fail closed；
 * 旧协议的 live permission/ask 则只能绑定当前已 attach 的 stream 会话。
 */
export function shouldProjectInteractionEvent(
  event: RecoverableInteractionEvent,
  selectedSessionId: string | null,
  attachedStreamSessionId: string | null,
): boolean {
  if (!selectedSessionId) return false;
  if (event.type === 'pending_interactions' || event.type === 'interaction_resolved') {
    return typeof event.sessionId === 'string' && event.sessionId === selectedSessionId;
  }
  return attachedStreamSessionId === selectedSessionId;
}
