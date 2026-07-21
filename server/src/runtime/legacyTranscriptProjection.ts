import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

import type { ModelChatMessage, ModelResponseMode, ModelUsage, PlatformEvent } from './types.js';
import {
  buildModelUserContent,
  buildPrunedHistoricalUserContent,
  pruneHistoricalImageContent,
} from './imageAttachments.js';

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
  return jsonl({
    type: 'assistant',
    message,
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

function userToolResultLine(toolUseId: string, content: string, sessionId: string, isError = false): string {
  return jsonl({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
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
        });
      }
      case 'tool_result':
        return userToolResultLine(event.toolCallId, event.content, event.sessionId, event.isError);
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

/**
 * 默认 tool_result 截断阈值：单条不超过 ~4K 字符（约 1.5K-2K token），
 * 超出部分用占位符接住，引导模型用 SessionSearchEvents 按 toolCallId 拉原文。
 */
const DEFAULT_TOOL_RESULT_MAX_CHARS = 4000;
/**
 * 默认优先保留最近 N 条 tool 消息。N=8 大致覆盖最近 2-3 轮
 * 工具调用（一轮平均 2-4 个并行/串行 call）。
 */
const DEFAULT_TOOL_RESULT_KEEP_RECENT = 8;
/** 最近工具结果也必须有单条上限，避免一次并行 Read 把下一轮请求直接撑爆。 */
const DEFAULT_RECENT_TOOL_RESULT_MAX_CHARS = 16_000;
/** 单次模型请求中全部 tool_result 的累计字符预算。 */
const DEFAULT_TOOL_RESULT_TOTAL_MAX_CHARS = 96_000;
const TOOL_RESULT_PLACEHOLDER_MAX_CHARS = 160;

export interface ToolResultTruncationOptions {
  /** 关掉截断（测试 / 调试 / 显式 full_replay 时用）。默认开启。 */
  enabled?: boolean;
  /** 单条 tool 消息最大字符数。超长尾部用占位符替换。 */
  maxChars?: number;
  /** 末尾多少条 tool 消息使用较大的 recentMaxChars 上限。 */
  keepRecent?: number;
  /** 最近 keepRecent 条的单条字符上限。默认 16K。 */
  recentMaxChars?: number;
  /** 全部 tool 消息的累计字符上限。默认 96K。 */
  maxTotalChars?: number;
}

/**
 * 给历史 messages 数组中"较旧的" tool 消息做就地截断。
 *
 * 设计原则：
 * - 只动 role='tool' 的消息，其它 role 完全不碰，前缀字节缓存语义不变。
 * - 最近 keepRecent 条 tool 使用更大的上限 — 模型刚做的工具调用，需要更多结果继续推理。
 * - 更早的 tool 消息只截掉超过 maxChars 的尾巴，前段照旧 + 显式占位符 +
 *   引导模型用 SessionSearchEvents 按 toolCallId 拉原文（如果需要）。
 *
 * 这是 O2 优化的核心：长 session 跨 run 重发历史时不再把 Read 整文件 /
 * grep 数千行 / Skill body 64K 反复打到 input_tokens 里。
 */
export function truncateOldToolResults(
  messages: ModelChatMessage[],
  options: ToolResultTruncationOptions = {},
): ModelChatMessage[] {
  if (options.enabled === false) return messages;
  const maxChars = options.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  const keepRecent = options.keepRecent ?? DEFAULT_TOOL_RESULT_KEEP_RECENT;
  const recentMaxChars = options.recentMaxChars ?? DEFAULT_RECENT_TOOL_RESULT_MAX_CHARS;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_TOOL_RESULT_TOTAL_MAX_CHARS;

  // 1) 标记每个 tool 消息的"从尾往前"的序号
  const toolIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'tool') toolIndices.push(i);
  }
  // 2) 从最新往最旧分配累计预算。最近结果优先，但也不能无限大；较旧结果
  // 保留头部和可检索指针。原文始终在 EventStore，不在模型请求里重复搬运。
  const bounded = new Map<number, ModelChatMessage>();
  let remainingTotal = Math.max(0, maxTotalChars);
  for (let position = 0; position < toolIndices.length; position += 1) {
    const idx = toolIndices[position]!;
    const message = messages[idx]!;
    if (message.role !== 'tool') continue;
    const remainingMessages = toolIndices.length - position;
    const placeholderReserve = Math.min(
      TOOL_RESULT_PLACEHOLDER_MAX_CHARS,
      Math.floor(remainingTotal / Math.max(1, remainingMessages)),
    );
    const availableNow = Math.max(0, remainingTotal - placeholderReserve * Math.max(0, remainingMessages - 1));
    const perMessageLimit = position < keepRecent ? recentMaxChars : maxChars;
    const budget = Math.min(perMessageLimit, availableNow);
    const content = truncateToolResultContent(message.content, budget, message.tool_call_id);
    remainingTotal = Math.max(0, remainingTotal - content.length);
    if (content !== message.content) bounded.set(idx, { ...message, content });
  }
  if (bounded.size === 0) return messages;
  return messages.map((message, idx) => bounded.get(idx) ?? message);
}

function truncateToolResultContent(content: string, maxChars: number, toolCallId: string): string {
  if (content.length <= maxChars) return content;
  if (maxChars <= 0) return '';
  const marker = `\n\n...[tool_result 已截断；完整原文请用 SessionGetToolTrace toolCallId=${toolCallId} 查询]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  const keptChars = maxChars - marker.length;
  return `${content.slice(0, keptChars)}${marker}`;
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
            : buildModelUserContent(event.modelContent ?? event.content, event.attachments, event.visionAnalysis),
        });
        break;
      case 'assistant_message':
        messages.push({
          role: 'assistant',
          content: event.content,
          ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
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
        });
        pendingReasoning = '';
        break;
      case 'tool_result':
        // tool_result 是 user→assistant 的反馈，不重置 thinking 缓存（下一条 assistant 仍可用）
        messages.push({
          role: 'tool',
          tool_call_id: event.toolCallId,
          content: event.content,
        });
        break;
      default:
        break;
    }
  }
  return messages;
}
