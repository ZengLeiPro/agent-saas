/**
 * Memory Maintenance Hook
 *
 * 包装 AgentRunDispatch，在 agent 运行结束后按策略触发记忆维护。
 * 维护通过一次独立的轻量 agent 调用完成（静默执行，不输出给用户）。
 */

import type { Logger } from '../utils/logger.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import type {
  ChannelContext,
  InboundMessage,
  OutboundEvent,
} from '../types/index.js';
import type {
  AgentRunDispatch,
  AgentRunHooks,
  AgentRunOptions,
} from '../agent/types.js';

// ============================================
// Types
// ============================================

export interface MemoryMaintenanceOptions {
  enabled: boolean;
  /** agent 回复最少字符数才触发维护（默认 500） */
  minTextLength: number;
  /** 两次维护之间的最短间隔（分钟，默认 60） */
  cooldownMinutes: number;
}

export interface CreateMemoryHookOptions {
  agentCwd: string;
  config: MemoryMaintenanceOptions;
  /** 用于维护调用的 dispatch（应为中间件包装后的版本，但不含 memory hook 自身） */
  maintenanceDispatch: AgentRunDispatch;
  logger?: Logger;
}

// ============================================
// Constants
// ============================================

const MAINTENANCE_CHAT_PREFIX = 'memory-maint-';

const MAINTENANCE_SYSTEM_CONTEXT =
  '记忆维护轮次。分析以下对话内容，将值得长期保留的信息写入记忆文件。' +
  '只做文件读写操作，不要产生面向用户的回复。没有需要记录的内容时，什么都不做。';

function buildMaintenancePrompt(
  userMessage: string,
  assistantResponse: string,
  date: string,
): string {
  const userSnippet = userMessage.length > 2000
    ? userMessage.slice(0, 2000) + '...[截断]'
    : userMessage;
  const assistantSnippet = assistantResponse.length > 4000
    ? assistantResponse.slice(0, 4000) + '...[截断]'
    : assistantResponse;

  return [
    `将以下对话中值得长期保留的信息追加写入 memory/${date}.md（如文件已存在，仅追加，不覆盖已有条目）。`,
    '如果没有值得记录的内容，不做任何操作。',
    '',
    '值得记录：用户偏好、重要决策、关键事实、有效方案、待办事项。',
    '不记录：临时性问答、敏感信息（密钥等）、已在 MEMORY.md 中的内容。',
    '',
    '---',
    `用户: ${userSnippet}`,
    '',
    `助手: ${assistantSnippet}`,
  ].join('\n');
}

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ============================================
// Hook Implementation
// ============================================

export function createMemoryMaintenanceHook(options: CreateMemoryHookOptions) {
  let lastMaintenanceAtMs = 0;

  return {
    async afterRun(
      result: { finalText: string; hasError: boolean; hasTools: boolean },
      originalMessage: InboundMessage,
      context: ChannelContext,
    ): Promise<void> {
      if (!options.config.enabled) return;
      if (result.hasError) return;
      if (result.finalText.length < options.config.minTextLength) return;

      // 仅对包含工具调用的对话触发（说明做了实质性工作）
      if (!result.hasTools) return;

      // 冷却期检查
      const now = Date.now();
      const cooldownMs = options.config.cooldownMinutes * 60 * 1000;
      if (now - lastMaintenanceAtMs < cooldownMs) return;

      lastMaintenanceAtMs = now;

      const maintenanceMessage: InboundMessage = {
        channel: context.channel,
        chatId: `${MAINTENANCE_CHAT_PREFIX}${now}`,
        content: buildMaintenancePrompt(
          originalMessage.content,
          result.finalText,
          formatDate(),
        ),
      };

      const maintenanceContext: ChannelContext = {
        channel: context.channel,
        systemContext: MAINTENANCE_SYSTEM_CONTEXT,
      };

      try {
        // 解析 per-user cwd，确保 maintenance 写入用户自己的 memory/ 目录
        const effectiveCwd = context.user
          ? resolveUserCwd(options.agentCwd, { id: context.user.id, username: context.user.username, role: context.user.role as 'admin' | 'user', tenantId: context.user.tenantId })
          : options.agentCwd;

        options.logger?.info('[memory-maintenance] triggered');
        for await (const _ of options.maintenanceDispatch(
          maintenanceMessage,
          maintenanceContext,
          { maxTurns: 3, persistSession: false, cwd: effectiveCwd },
        )) {
          // Drain events silently
        }
        options.logger?.info('[memory-maintenance] completed');
      } catch (error) {
        options.logger?.error(
          `[memory-maintenance] failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

// ============================================
// Dispatch Wrapper
// ============================================

/**
 * 包装 AgentRunDispatch，在事件流结束后按策略触发记忆维护。
 * 事件流本身不受影响（pass-through），维护在流结束后异步执行。
 */
export function withMemoryMaintenance(
  upstream: AgentRunDispatch,
  hook: ReturnType<typeof createMemoryMaintenanceHook>,
): AgentRunDispatch {
  return async function* (
    message: InboundMessage,
    context: ChannelContext,
    options?: AgentRunOptions,
    hooks?: AgentRunHooks,
  ): AsyncGenerator<OutboundEvent> {
    // 跳过记忆维护自身的调用，防止递归
    if (message.chatId.startsWith(MAINTENANCE_CHAT_PREFIX)) {
      yield* upstream(message, context, options, hooks);
      return;
    }

    let finalText = '';
    let hasError = false;
    let hasTools = false;

    for await (const event of upstream(message, context, options, hooks)) {
      // 追踪状态
      if (event.type === 'text_delta') finalText += event.content || '';
      if (event.type === 'error') hasError = true;
      if (event.type === 'tool_start') hasTools = true;

      yield event;
    }

    // 事件流结束后，fire-and-forget 触发维护
    hook
      .afterRun({ finalText, hasError, hasTools }, message, context)
      .catch(() => {});
  };
}
