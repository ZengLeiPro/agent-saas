import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

import type { ModelChatMessage, ModelUsage, PlatformEvent } from './types.js';

function jsonl(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function userLine(content: string, sessionId: string): string {
  return jsonl({
    type: 'user',
    message: { role: 'user', content },
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

function assistantLine(
  content: unknown[],
  sessionId: string,
  extra: { model?: string; usage?: ModelUsage } = {},
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
        return userLine(event.content, event.sessionId);
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
 * 默认保留最近 N 条 tool 消息原文（不截断）。N=8 大致覆盖最近 2-3 轮
 * 工具调用（一轮平均 2-4 个并行/串行 call）。
 */
const DEFAULT_TOOL_RESULT_KEEP_RECENT = 8;

export interface ToolResultTruncationOptions {
  /** 关掉截断（测试 / 调试 / 显式 full_replay 时用）。默认开启。 */
  enabled?: boolean;
  /** 单条 tool 消息最大字符数。超长尾部用占位符替换。 */
  maxChars?: number;
  /** 末尾保留多少条 tool 消息原文（不截断）。 */
  keepRecent?: number;
}

/**
 * 给历史 messages 数组中"较旧的" tool 消息做就地截断。
 *
 * 设计原则：
 * - 只动 role='tool' 的消息，其它 role 完全不碰，前缀字节缓存语义不变。
 * - 最近 keepRecent 条 tool 完整保留 — 模型刚做的工具调用，需要看完整结果继续推理。
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

  // 1) 标记每个 tool 消息的"从尾往前"的序号
  const toolIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'tool') toolIndices.push(i);
  }
  if (toolIndices.length <= keepRecent) return messages;

  // 2) 倒数 keepRecent 个 tool 不动，更早的截断
  const toolsToTruncate = new Set(toolIndices.slice(keepRecent));
  return messages.map((m, idx) => {
    if (m.role !== 'tool') return m;
    if (!toolsToTruncate.has(idx)) return m;
    if (m.content.length <= maxChars) return m;
    const kept = m.content.slice(0, maxChars);
    const truncated = m.content.length - maxChars;
    return {
      ...m,
      content:
        kept
        + `\n\n...[历史 tool_result 已截断 ${truncated} 字符以节省 context；`
        + `如需完整原文，调用 SessionSearchEvents 工具按 toolCallId=${m.tool_call_id} 查询]`,
    };
  });
}

export function buildChatMessagesFromEvents(events: PlatformEvent[]): ModelChatMessage[] {
  const messages: ModelChatMessage[] = [];
  // RFC v1 P1.5：暂存 thinking 内容，合并到紧接其后的 assistant_message / assistant_tool_calls
  // 上作为 reasoning_content。这是回放历史的"reasoning 不丢失"路径。
  // 注：火山 Chat Completions 会静默丢弃 reasoning_content（RFC §1.3），但当前实现的真正
  // 价值是为未来 Anthropic Messages / OpenAI Responses 官方端点准备好语义完整的输入。
  let pendingReasoning = '';
  for (const event of events) {
    switch (event.type) {
      case 'memory_context':
        pendingReasoning = '';
        messages.push({ role: 'user', content: event.content });
        break;
      case 'user_message':
        pendingReasoning = '';
        messages.push({ role: 'user', content: event.modelContent ?? event.content });
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
