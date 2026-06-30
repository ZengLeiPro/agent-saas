import type { ChannelContext, InboundMessage } from '../types/index.js';
import { addTimestampPrefix } from '../utils/timestamp.js';

export type AgentPromptInput = string;

/**
 * 构建发给 raw runtime 的用户消息
 *
 * 用户标识已注入 systemPrompt（见 runner.ts），此处构建用户消息。
 * 如有通道级 systemContext（如 DingTalk 的消息上下文），保留作为前缀以便 AI 理解来源。
 * 长期记忆不在这里拼入当前用户消息；runtime 会把它作为会话开头的独立上下文事件注入。
 */
export function buildPrompt(
  message: InboundMessage,
  context: ChannelContext,
): string {
  // 平台内置斜杠命令必须原样传递（不加时间戳/上下文包装）
  const trimmed = message.content.trim();
  if (trimmed === '/compact' || trimmed === '/clear' || trimmed === '/help') {
    return trimmed;
  }

  const timestampedContent = addTimestampPrefix(message.content, context.timezone);

  let result: string;
  // 通道级 systemContext（如 DingTalk 的 [钉钉消息上下文]）保留在用户消息中
  if (context.systemContext) {
    result = `${context.systemContext}\n\n[用户消息]\n${timestampedContent}`;
  } else {
    result = timestampedContent;
  }

  return result;
}

export function buildPromptInput(
  message: InboundMessage,
  context: ChannelContext,
): AgentPromptInput {
  return buildPrompt(message, context);
}
