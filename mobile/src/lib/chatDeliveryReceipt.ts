import type { MessageItem, WsEvent, WsProcessingContext } from '@agent/shared';

export interface MobileChatDelivery {
  clientMsgId: string;
  sessionId?: string;
  state: 'sending' | 'verifying' | 'acked';
}
interface BubbleTarget {
  messagesRef: { current: MessageItem[] };
  updateMessageAt(index: number, update: (message: MessageItem) => MessageItem): void;
}

/** A receipt is correlated to a visible intent, never to a fallback index from another conversation. */
export function hasMobileChatBubble(messages: readonly MessageItem[], clientMsgId: string): boolean {
  return messages.some((message) => (message.type === 'user' || message.type === 'user-voice')
    && message.clientMsgId === clientMsgId);
}

/** Server acceptance settles delivery even if stream_id is delayed or the local ACK deadline expired. */
export function acknowledgeMobileChatBubble(target: BubbleTarget, clientMsgId: string, queued = false): void {
  const index = target.messagesRef.current.findIndex((message) =>
    (message.type === 'user' || message.type === 'user-voice') && message.clientMsgId === clientMsgId);
  if (index < 0) return;
  target.updateMessageAt(index, (message) => {
    if ((message.type !== 'user' && message.type !== 'user-voice') || message.clientMsgId !== clientMsgId) return message;
    if (message.status === 'sent' || (message.type === 'user' && message.status === 'queued')) return message;
    // A queued text intent stays queued until the shared stream/queue reducer promotes it.
    // Voice has no queued display state; sent means server acceptance, not completed execution.
    if (message.type === 'user') return { ...message, status: queued ? 'queued' : 'sent', failedReason: undefined };
    return { ...message, status: 'sent', failedReason: undefined };
  });
}

/**
 * Receipt and transport completion may arrive in either order. The timer is owned by this exact
 * attempt object; acknowledgement, removal, view change or retry invalidates it without resending.
 */
export function armMobileChatAckDeadline<T extends MobileChatDelivery>(clientMsgId: string, options: {
  timers: Map<string, ReturnType<typeof setTimeout>>;
  getEntry: (clientMsgId: string) => T | undefined;
  timeoutMs: number;
  onExpired: (entry: T) => void;
}): void {
  const { timers, getEntry, timeoutMs, onExpired } = options;
  const existing = timers.get(clientMsgId);
  if (existing !== undefined) clearTimeout(existing);
  timers.delete(clientMsgId);
  const entry = getEntry(clientMsgId);
  if (!entry || entry.state !== 'sending') return;
  const timer = setTimeout(() => {
    if (timers.get(clientMsgId) !== timer) return;
    timers.delete(clientMsgId);
    if (getEntry(clientMsgId) !== entry || entry.state !== 'sending') return;
    entry.state = 'verifying';
    onExpired(entry);
  }, timeoutMs);
  timers.set(clientMsgId, timer);
}

type ReceiptHandlers = Required<Pick<WsProcessingContext, 'onChatAck' | 'onChatRejected' | 'onChatDone'>>;

/**
 * The hook supplies view/session effects; this module owns delivery settlement. All callbacks retain
 * the shared WsEvent contract and narrow the discriminant before reading ACK-only fields.
 */
export function createMobileChatReceiptHandlers<T extends MobileChatDelivery>(options: {
  target: BubbleTarget;
  outbox: { current: T[] };
  timers: Map<string, ReturnType<typeof setTimeout>>;
  sourceEvent: WsEvent;
  getSelectedSessionId: () => string | null;
  confirmSession: (sessionId: string) => void;
  onAllRejected: () => void;
  observeAck?: (clientMsgId: string, event?: WsEvent) => void;
}): ReceiptHandlers {
  const { target, outbox, timers } = options;
  const clearTimer = (clientMsgId: string) => {
    const timer = timers.get(clientMsgId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(clientMsgId);
  };
  const removeEntry = (clientMsgId: string) => {
    clearTimer(clientMsgId);
    outbox.current = outbox.current.filter((entry) => entry.clientMsgId !== clientMsgId);
  };
  return {
    onChatAck(clientMsgId, event) {
      clearTimer(clientMsgId);
      const entry = outbox.current.find((item) => item.clientMsgId === clientMsgId);
      if (entry) entry.state = 'acked';
      const receipt = event ?? options.sourceEvent;
      const ack = receipt.type === 'chat_ack' ? receipt : undefined;
      const queued = receipt.type === 'stream_id' ? receipt.queued === true
        : receipt.type === 'message_queued' || receipt.type === 'steering_queued'
          || Boolean(ack && (!ack.status || ack.status === 'accepted' || ack.status === 'queued'));
      acknowledgeMobileChatBubble(target, clientMsgId, queued);
      // Only the exact visible intent may bind a new draft to a server-created session.
      if (entry && ack?.sessionId && hasMobileChatBubble(target.messagesRef.current, clientMsgId)) {
        if (!entry.sessionId && !options.getSelectedSessionId()) options.confirmSession(ack.sessionId);
        entry.sessionId = ack.sessionId;
      }
      try { options.observeAck?.(clientMsgId, event); }
      catch { /* Telemetry failure must never undo or prevent authoritative delivery settlement. */ }
    },
    onChatRejected(clientMsgId) {
      removeEntry(clientMsgId);
      if (outbox.current.every((entry) => entry.state !== 'acked' && entry.state !== 'sending')) {
        options.onAllRejected();
      }
    },
    onChatDone(clientMsgId) {
      if (clientMsgId) removeEntry(clientMsgId);
    },
  };
}
