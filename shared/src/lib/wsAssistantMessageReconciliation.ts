import type { MessageItem } from '../types/message';
import type { MessagesController, WsBlockState } from './wsEventProcessorHelpers';

type AssistantMessage = Extract<MessageItem, { type: 'text' | 'thinking' }>;

function isTranscriptId(id: string): boolean {
  return id.startsWith('line-');
}

function mergeAssistantMessage(
  current: AssistantMessage,
  incoming: AssistantMessage,
): AssistantMessage {
  const content =
    incoming.content.length >= current.content.length ? incoming.content : current.content;
  return {
    ...current,
    ...incoming,
    id: isTranscriptId(current.id) || !isTranscriptId(incoming.id) ? current.id : incoming.id,
    content,
    runId: current.runId ?? incoming.runId,
    streaming: incoming.streaming === true && current.streaming === true,
  };
}

/** Replay/live text 与 transcript 使用不同 block id；同 run 同正文只保留一条。 */
export function reconcileProjectedAssistantMessage(
  item: MessageItem,
  msg: MessagesController,
  block: WsBlockState,
): boolean {
  if ((item.type !== 'text' && item.type !== 'thinking') || !item.runId || !item.content.trim())
    return false;
  const messages = msg.messagesRef.current;
  const matches = messages.flatMap((candidate, index) =>
    candidate.type === item.type &&
    candidate.runId === item.runId &&
    (candidate.id === item.id || candidate.content === item.content)
      ? [index]
      : [],
  );
  if (matches.length === 0) return false;

  const preferred = matches.find((index) => isTranscriptId(messages[index].id)) ?? matches[0];
  let merged = messages[preferred] as AssistantMessage;
  for (const index of matches) {
    if (index === preferred) continue;
    merged = mergeAssistantMessage(merged, messages[index] as AssistantMessage);
  }
  merged = mergeAssistantMessage(merged, item);
  msg.updateMessageAt(preferred, () => merged);
  if (matches.length === 1) return true;

  const removed = new Set(matches.filter((index) => index !== preferred));
  const activeIndex = matches.includes(block.currentBlockIndex)
    ? preferred
    : block.currentBlockIndex;
  block.currentBlockIndex =
    activeIndex - [...removed].filter((index) => index < activeIndex).length;
  const next = msg.messagesRef.current.filter((_, index) => !removed.has(index));
  msg.messagesRef.current = next;
  msg.setMessages?.(next, { scrollToBottom: false });
  return true;
}
