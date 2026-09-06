import type { MessageItem } from '../types/message';
import type { MessagesController, WsBlockState } from './wsEventProcessorHelpers';

type ToolMessage = Extract<MessageItem, { type: 'tool_use' }>;

function isTerminal(message: ToolMessage): boolean {
  return (
    message.resultReady === true ||
    message.executionStatus === 'completed' ||
    message.executionStatus === 'failed' ||
    message.executionStatus === 'cancelled'
  );
}

function mergeToolMessage(current: ToolMessage, incoming: ToolMessage): ToolMessage {
  return {
    ...current,
    ...incoming,
    toolName: incoming.toolName === 'unknown' ? current.toolName : incoming.toolName,
    toolInput: incoming.toolInput || current.toolInput,
    executionStatus:
      isTerminal(current) && !isTerminal(incoming)
        ? current.executionStatus
        : incoming.executionStatus,
    streaming: isTerminal(current) || isTerminal(incoming) ? false : incoming.streaming,
  };
}

/** 参数骨架、历史块和执行投影以 runId + toolId 认领同一次调用。 */
export function reconcileProjectedToolMessage(
  item: MessageItem,
  msg: MessagesController,
  block: WsBlockState,
): boolean {
  if (item.type !== 'tool_use' || !item.toolId) return false;
  const messages = msg.messagesRef.current;
  const matches = messages.flatMap((candidate, index) =>
    candidate.type === 'tool_use' &&
    candidate.toolId === item.toolId &&
    (!candidate.runId || candidate.runId === item.runId)
      ? [index]
      : [],
  );
  if (matches.length === 0) return false;

  const first = matches[0];
  let merged = messages[first] as ToolMessage;
  for (const index of matches.slice(1)) {
    merged = mergeToolMessage(merged, messages[index] as ToolMessage);
  }
  merged = mergeToolMessage(merged, item);
  msg.updateMessageAt(first, () => merged);
  if (matches.length > 1) {
    // 已经显示出的旧重复行也原位收拢；同步修正仍在接收参数的旧位置指针。
    const removed = new Set(matches.slice(1));
    const activeIndex = matches.includes(block.currentBlockIndex) ? first : block.currentBlockIndex;
    block.currentBlockIndex =
      activeIndex - [...removed].filter((index) => index < activeIndex).length;
    // updateMessageAt 可能采用 copy-on-write，必须从更新后的 ref 取合并结果。
    const next = msg.messagesRef.current.filter((_, index) => !removed.has(index));
    msg.messagesRef.current = next;
    msg.setMessages?.(next, { scrollToBottom: false });
  }
  return true;
}
