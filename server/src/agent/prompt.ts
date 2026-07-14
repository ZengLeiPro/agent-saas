import type { ChannelContext, InboundMessage } from '../types/index.js';
import type { ModelAttachmentRef } from '../runtime/types.js';
import { addTimestampPrefix } from '../utils/timestamp.js';

export type AgentPromptInput = string;

/**
 * /compact 平台命令判定（2026-07-03 真实现）。
 * rawRuntimeRunDispatch 用它把 /compact 分流到 RawAgentLoop.compact()（上下文压缩），
 * 不再进入正常 agent run，也不会到达 buildPrompt。
 */
export function isCompactCommand(content: string): boolean {
  return content.trim() === '/compact';
}

/**
 * 构建发给 raw runtime 的用户消息
 *
 * 用户标识已注入 systemPrompt（见 runner.ts），此处构建用户消息。
 * 如有通道级 systemContext（如 DingTalk 的消息上下文），保留作为前缀以便 AI 理解来源。
 * 长期记忆不在这里拼入当前用户消息；runtime 会把它作为会话开头的独立上下文事件注入。
 *
 * 历史注：SDK 时代曾对 /compact、/clear、/help 豁免包装原样透传（SDK 内建命令）。
 * raw runtime 下 /compact 已由 dispatch 拦截真实现（见 isCompactCommand）；
 * /clear、/help 无平台实现，按普通消息正常包装，由模型自然应答。
 */
export function buildPrompt(
  message: InboundMessage,
  context: ChannelContext,
  attachments: readonly ModelAttachmentRef[] = [],
): string {
  const timestampedContent = addTimestampPrefix(message.content, context.timezone);

  let result: string;
  // 通道级 systemContext（如 DingTalk 的 [钉钉消息上下文]）保留在用户消息中
  if (context.systemContext) {
    result = `${context.systemContext}\n\n[用户消息]\n${timestampedContent}`;
  } else {
    result = timestampedContent;
  }

  if (attachments.length > 0) {
    const manifest = attachments.map((attachment, index) => JSON.stringify({
      index: index + 1,
      attachmentId: attachment.attachmentId,
      originalName: attachment.originalName,
      relativePath: attachment.relativePath,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      isImage: attachment.isImage,
      ...(attachment.width ? { width: attachment.width } : {}),
      ...(attachment.height ? { height: attachment.height } : {}),
    })).join('\n');
    result += `\n\n[本轮附件清单（服务端已校验）]\n${manifest}`
      + '\n仅将以上 attachmentId 视为本轮附件；不要扫描 uploads 目录猜测附件。图片已作为本轮多模态内容直接提供。';
  }

  return result;
}

export function buildPromptInput(
  message: InboundMessage,
  context: ChannelContext,
  attachments: readonly ModelAttachmentRef[] = [],
): AgentPromptInput {
  return buildPrompt(message, context, attachments);
}
