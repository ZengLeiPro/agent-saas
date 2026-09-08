import type { MessageItem } from '@agent/shared';

export interface MobileChatDelivery {
  clientMsgId: string;
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
