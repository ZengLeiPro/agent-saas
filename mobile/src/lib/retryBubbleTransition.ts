import type { MessageItem, MessageItemInput } from '@agent/shared';

export function replaceRetryBubble(
  messages: MessageItem[],
  retryMessageId: string,
  replacement: MessageItemInput,
): { messages: MessageItem[]; index: number } | null {
  const index = messages.findIndex((message) => message.id === retryMessageId);
  if (index < 0) return null;
  return {
    index,
    messages: messages.map((message, messageIndex) => (
      messageIndex === index
        ? { ...replacement, id: message.id } as MessageItem
        : message
    )),
  };
}
