import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

import type { ToolPresentation } from '../agent/toolPresentationBuilder.js';
import type {
  ModelChatMessage,
  ModelResponseMode,
  ModelUsage,
  ModelWireMode,
  PlatformEvent,
} from './types.js';
import {
  buildModelUserContent,
  buildPrunedHistoricalUserContent,
  pruneHistoricalImageContent,
} from './imageAttachments.js';
import {
  projectToolResultContentForModel,
} from './replayEventBounds.js';

function jsonl(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function userLine(
  content: string,
  sessionId: string,
  attachments?: ReadonlyArray<{ originalName: string; isImage: boolean; relativePath: string }>,
): string {
  return jsonl({
    type: 'user',
    message: { role: 'user', content },
    // 刷新后前端历史回放的附件展示来源（parse.ts → prompt block.attachments）。
    // relativePath 供前端点击预览/下载（走 /api/file 端点，workspace 内路径校验）；
    // 完整 ModelAttachmentRef 仍在 PG event store。
    ...(attachments?.length
      ? {
        attachments: attachments.map((a) => ({
          name: a.originalName,
          isImage: a.isImage,
          relativePath: a.relativePath,
        })),
      }
      : {}),
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

function assistantLine(
  content: unknown[],
  sessionId: string,
  extra: {
    model?: string;
    usage?: ModelUsage;
    responseMode?: ModelResponseMode;
    responseChained?: boolean;
    modelRequestAttemptCount?: number;
    promptCacheKey?: string;
    requestInputPrefixHash?: string;
    requestBodyBytes?: number;
    wireMode?: ModelWireMode;
    wireRequestBodyBytes?: number;
    wireFallbackReason?: string;
  } = {},
): string {
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (extra.model) message.model = extra.model;
  if (extra.usage) {
    message.usage = {
      input_tokens: extra.usage.inputTokens ?? 0,
      output_tokens: extra.usage.outputTokens ?? 0,
      cache_read_input_tokens: extra.usage.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: extra.usage.cacheCreationInputTokens ?? 0,
      api_request_count: extra.usage.apiRequestCount ?? 1,
    };
  }
  if (extra.responseMode) message.response_mode = extra.responseMode;
  if (extra.responseChained !== undefined) message.response_chained = extra.responseChained;
  if (extra.modelRequestAttemptCount !== undefined) {
    message.model_request_attempt_count = extra.modelRequestAttemptCount;
  }
  if (extra.promptCacheKey) message.prompt_cache_key = extra.promptCacheKey;
  if (extra.requestInputPrefixHash) message.request_input_prefix_hash = extra.requestInputPrefixHash;
  if (extra.requestBodyBytes !== undefined) message.request_body_bytes = extra.requestBodyBytes;
  if (extra.wireMode) message.wire_mode = extra.wireMode;
  if (extra.wireRequestBodyBytes !== undefined) {
    message.wire_request_body_bytes = extra.wireRequestBodyBytes;
  }
  if (extra.wireFallbackReason) message.wire_fallback_reason = extra.wireFallbackReason;
  return jsonl({
    type: 'assistant',
    message,
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

function userToolResultLine(
  toolUseId: string,
  content: string,
  sessionId: string,
  isError = false,
  presentation?: ToolPresentation,
  metadata?: Record<string, unknown>,
): string {
  return jsonl({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError,
        // 纯追加字段：老 server 读新文件只取自己认识的 key，新 server 读老文件
        // 取不到即 undefined —— 双向兼容，不需要 JSONL schema 版本号。
        // 解析侧按 tool_use_id 反向嫁接到 tool_use block（见 parse.ts）。
        ...(presentation ? { presentation } : {}),
        // 同上，与 presentation 同一条嫁接通道；这一份是给程序判定的原值
        // （exitCode 等），前端 ✓/✗ 徽标优先读它而不是从正文正则回捞。
        ...(metadata ? { metadata } : {}),
      }],
    },
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

export class LegacyTranscriptProjection {
  constructor(private readonly transcriptPath: string) {}

  async project(event: PlatformEvent): Promise<void> {
    const line = this.lineForEvent(event);
    if (!line) return;
    await mkdir(dirname(this.transcriptPath), { recursive: true });
    await appendFile(this.transcriptPath, line, 'utf-8');
  }

  private lineForEvent(event: PlatformEvent): string | null {
    switch (event.type) {
      case 'memory_context':
        return null;
      case 'user_message':
        // 系统命令替身（/compact 等）不进前端历史——压缩在 transcript 里由
        // compaction line（分界线）呈现，命令气泡本身不保留
        if (event.modelContent?.startsWith('[系统命令]')) return null;
        return userLine(event.content, event.sessionId, event.attachments);
      case 'compaction':
        // v2：投影为压缩分界线。前端渲染分界线组件；摘要仅 debugMode 展开查看
        return jsonl({
          type: 'compaction',
          summary: event.summary,
          coveredEventCount: event.coveredEventCount,
          sessionId: event.sessionId,
          timestamp: new Date().toISOString(),
        });
      case 'assistant_message':
        return assistantLine(
          [{ type: 'text', text: event.content }],
          event.sessionId,
          {
            ...(event.model ? { model: event.model } : {}),
            ...(event.usage ? { usage: event.usage } : {}),
            ...(event.responseMode ? { responseMode: event.responseMode } : {}),
            ...(event.responseChained !== undefined ? { responseChained: event.responseChained } : {}),
            ...(event.modelRequestAttemptCount !== undefined
              ? { modelRequestAttemptCount: event.modelRequestAttemptCount }
              : {}),
            ...(event.promptCacheKey ? { promptCacheKey: event.promptCacheKey } : {}),
            ...(event.requestInputPrefixHash
              ? { requestInputPrefixHash: event.requestInputPrefixHash }
              : {}),
            ...(event.requestBodyBytes !== undefined ? { requestBodyBytes: event.requestBodyBytes } : {}),
            ...(event.wireMode ? { wireMode: event.wireMode } : {}),
            ...(event.wireRequestBodyBytes !== undefined
              ? { wireRequestBodyBytes: event.wireRequestBodyBytes }
              : {}),
            ...(event.wireFallbackReason ? { wireFallbackReason: event.wireFallbackReason } : {}),
          },
        );
      case 'assistant_thinking':
        return assistantLine(
          [{ type: 'thinking', thinking: event.content }],
          event.sessionId,
        );
      case 'assistant_tool_calls': {
        const content: unknown[] = [];
        if (event.content) {
          content.push({ type: 'text', text: event.content });
        }
        for (const call of event.toolCalls) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: parseToolArguments(call.arguments),
          });
        }
        return assistantLine(content, event.sessionId, {
          ...(event.model ? { model: event.model } : {}),
          ...(event.usage ? { usage: event.usage } : {}),
          ...(event.responseMode ? { responseMode: event.responseMode } : {}),
          ...(event.responseChained !== undefined ? { responseChained: event.responseChained } : {}),
          ...(event.modelRequestAttemptCount !== undefined
            ? { modelRequestAttemptCount: event.modelRequestAttemptCount }
            : {}),
          ...(event.promptCacheKey ? { promptCacheKey: event.promptCacheKey } : {}),
          ...(event.requestInputPrefixHash ? { requestInputPrefixHash: event.requestInputPrefixHash } : {}),
          ...(event.requestBodyBytes !== undefined ? { requestBodyBytes: event.requestBodyBytes } : {}),
          ...(event.wireMode ? { wireMode: event.wireMode } : {}),
          ...(event.wireRequestBodyBytes !== undefined
            ? { wireRequestBodyBytes: event.wireRequestBodyBytes }
            : {}),
          ...(event.wireFallbackReason ? { wireFallbackReason: event.wireFallbackReason } : {}),
        });
      }
      case 'tool_result':
        return userToolResultLine(
          event.toolCallId,
          event.content,
          event.sessionId,
          event.isError,
          event.presentation,
          event.metadata,
        );
      default:
        return null;
    }
  }
}

function parseToolArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { __raw: raw };
  }
}

export function buildChatMessagesFromEvents(events: PlatformEvent[]): ModelChatMessage[] {
  const messages: ModelChatMessage[] = [];
  const prunedImageEventIndices = pruneHistoricalImageContent(events);
  // RFC v1 P1.5：暂存 thinking 内容，合并到紧接其后的 assistant_message / assistant_tool_calls
  // 上作为 reasoning_content。这是回放历史的"reasoning 不丢失"路径。
  // 注：火山 Chat Completions 会静默丢弃 reasoning_content（RFC §1.3），但当前实现的真正
  // 价值是为未来 Anthropic Messages / OpenAI Responses 官方端点准备好语义完整的输入。
  let pendingReasoning = '';
  for (const [eventIndex, event] of events.entries()) {
    switch (event.type) {
      case 'memory_context':
        pendingReasoning = '';
        messages.push({ role: 'user', content: event.content });
        break;
      case 'user_message':
        pendingReasoning = '';
        messages.push({
          role: 'user',
          content: prunedImageEventIndices.has(eventIndex)
            ? buildPrunedHistoricalUserContent(event.modelContent ?? event.content, event.attachments)
            : buildModelUserContent(
              event.modelContent ?? event.content,
              event.attachments,
              event.visionAnalysis,
              { historical: true },
            ),
        });
        break;
      case 'assistant_message':
        if (event.providerContinuationReset) clearProviderContinuations(messages);
        messages.push({
          role: 'assistant',
          content: event.content,
          ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
          ...(event.providerContinuation
            ? { provider_continuation: event.providerContinuation }
            : {}),
        });
        pendingReasoning = '';
        break;
      case 'assistant_thinking':
        // 不直接进 messages 数组；累积到下一条 assistant 上（多段 thinking 会拼接）
        pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${event.content}` : event.content;
        break;
      case 'mcp_tools_loaded':
        messages.push({ role: 'additional_tools', tools: event.tools });
        break;
      case 'assistant_tool_calls':
        if (event.providerContinuationReset) clearProviderContinuations(messages);
        messages.push({
          role: 'assistant',
          content: event.content || null,
          tool_calls: event.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: call.arguments,
            },
            ...(call.namespace ? { namespace: call.namespace } : {}),
          })),
          ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
          ...(event.providerContinuation
            ? { provider_continuation: event.providerContinuation }
            : {}),
        });
        pendingReasoning = '';
        break;
      case 'tool_result':
        // tool_result 是 user→assistant 的反馈，不重置 thinking 缓存（下一条 assistant 仍可用）
        messages.push({
          role: 'tool',
          tool_call_id: event.toolCallId,
          content: projectToolResultContentForModel(
            event.modelContent ?? event.content,
            event.toolCallId,
          ),
        });
        break;
      default:
        break;
    }
  }
  return messages;
}

function clearProviderContinuations(messages: ModelChatMessage[]): void {
  for (const message of messages) {
    if (message.role === 'assistant' && message.provider_continuation) {
      delete message.provider_continuation;
    }
  }
}
