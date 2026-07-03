/**
 * Event Consumer
 *
 * 通用事件消费层：遍历 OutboundEvent 流、管理状态（工具追踪、文本累积），
 * 通道只需实现 EventHandler 回调接口，专注于"收到事件后如何发送"。
 */

import type {
  OutboundEvent,
  ContextUsageData,
  PluginInstallData,
  NotificationData,
  MemoryRecallData,
  CompactionOutboundData,
} from '../types/index.js';
import { resolveDisplayToolName } from './toolNameResolver.js';
import type { ResolveToolNameParams, ToolNameResolver } from './toolNameResolver.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EventConsumer');

// ============================================
// Types
// ============================================

/** 消费结果 */
export interface ConsumeResult {
  sessionId: string | undefined;
  /** 所有 text_delta 的拼接 */
  finalText: string;
  hasError: boolean;
}

/** 只读工具追踪状态（供回调读取） */
export interface ToolTracker {
  readonly toolNameMap: ReadonlyMap<string, string>;
  readonly currentToolId: string | null;
  readonly currentToolInput: string;
}

export type { ResolveToolNameParams, ToolNameResolver };

export interface EventConsumerOptions {
  resolveToolName?: ToolNameResolver;
}

/** 通道实现的回调接口（全部可选） */
export interface EventHandler {
  onSessionInit?(sessionId: string): void | Promise<void>;
  onThinkingStart?(): void | Promise<void>;
  onThinkingDelta?(content: string): void | Promise<void>;
  onThinkingEnd?(): void | Promise<void>;
  onTextStart?(): void | Promise<void>;
  onTextDelta?(content: string, accumulatedText: string): void | Promise<void>;
  onTextEnd?(blockText: string): void | Promise<void>;
  onToolStart?(toolId: string, toolName: string, tracker: ToolTracker): void | Promise<void>;
  onToolInputDelta?(partialJson: string, toolId: string, toolName: string): void | Promise<void>;
  onToolEnd?(toolId: string, resolvedToolName: string, toolInput: string): void | Promise<void>;
  onToolResult?(toolId: string, toolName: string, result: string): void | Promise<void>;
  // SDK 0.2.112+ 新事件透传
  onContextUsage?(usage: ContextUsageData): void | Promise<void>;
  onPluginInstall?(data: PluginInstallData): void | Promise<void>;
  onNotification?(data: NotificationData): void | Promise<void>;
  onMemoryRecall?(data: MemoryRecallData): void | Promise<void>;
  // /compact v2：压缩黑箱事件（开始 / 结束）
  onCompactionStart?(): void | Promise<void>;
  onCompactionEnd?(data: CompactionOutboundData | undefined): void | Promise<void>;
  onDone?(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
  onFinally?(result: ConsumeResult): void | Promise<void>;
}

// ============================================
// EventConsumer
// ============================================

export class EventConsumer implements ToolTracker {
  constructor(private readonly options: EventConsumerOptions = {}) {}

  // 会话 & 文本状态
  private sessionId: string | undefined;
  private finalText = '';
  private currentTextBlock = '';
  private hasError = false;

  // 工具追踪状态（实现 ToolTracker 接口）
  private _toolNameMap = new Map<string, string>();
  private _currentToolId: string | null = null;
  private _currentToolInput = '';

  get toolNameMap(): ReadonlyMap<string, string> {
    return this._toolNameMap;
  }
  get currentToolId(): string | null {
    return this._currentToolId;
  }
  get currentToolInput(): string {
    return this._currentToolInput;
  }

  private resolveToolName(params: ResolveToolNameParams): string {
    const resolver = this.options.resolveToolName;
    if (!resolver) {
      return params.toolName;
    }
    try {
      const resolved = resolver(params);
      return resolved || params.toolName;
    } catch {
      return params.toolName;
    }
  }

  /**
   * 消费事件流，按事件类型调用 handler 回调。
   * 可选的 signal 参数用于在连接断开时提前终止消费，避免浪费 CPU 处理无人接收的事件。
   */
  async consume(
    events: AsyncGenerator<OutboundEvent>,
    handler: EventHandler,
    signal?: AbortSignal,
  ): Promise<ConsumeResult> {
    try {
      for await (const event of events) {
        if (signal?.aborted) {
          await handler.onDone?.();
          break;
        }

        switch (event.type) {
          case 'session_init':
            this.sessionId = event.sessionId;
            await handler.onSessionInit?.(event.sessionId!);
            break;

          case 'thinking_start':
            await handler.onThinkingStart?.();
            break;

          case 'thinking_delta':
            await handler.onThinkingDelta?.(event.content || '');
            break;

          case 'thinking_end':
            await handler.onThinkingEnd?.();
            break;

          case 'text_start':
            this.currentTextBlock = '';
            await handler.onTextStart?.();
            break;

          case 'text_delta': {
            const content = event.content || '';
            this.currentTextBlock += content;
            this.finalText += content;
            await handler.onTextDelta?.(content, this.finalText);
            break;
          }

          case 'text_end': {
            const blockText = this.currentTextBlock;
            this.currentTextBlock = '';
            await handler.onTextEnd?.(blockText);
            break;
          }

          case 'tool_start':
            if (event.toolId && event.toolName) {
              const resolvedToolName = this.resolveToolName({
                toolId: event.toolId,
                toolName: event.toolName,
                toolInput: '',
              });
              this._currentToolId = event.toolId;
              this._toolNameMap.set(event.toolId, resolvedToolName);
              this._currentToolInput = '';
              await handler.onToolStart?.(event.toolId, resolvedToolName, this);
            }
            break;

          case 'tool_input_delta': {
            const partialJson = event.partialJson || '';
            this._currentToolInput += partialJson;
            const toolName = (event.toolId && this._toolNameMap.get(event.toolId)) || event.toolName || '';
            await handler.onToolInputDelta?.(partialJson, event.toolId || '', toolName);
            break;
          }

          case 'tool_end': {
            if (this._currentToolId) {
              const toolId = this._currentToolId;
              const originalName = this._toolNameMap.get(toolId) || event.toolName || '';
              const toolInput = this._currentToolInput;
              const resolvedName = this.resolveToolName({
                toolId,
                toolName: originalName,
                toolInput,
              });

              this._toolNameMap.set(toolId, resolvedName);

              this._currentToolInput = '';
              this._currentToolId = null;

              await handler.onToolEnd?.(toolId, resolvedName, toolInput);
            }
            break;
          }

          case 'tool_result': {
            const toolId = event.toolId || '';
            const toolName = this._toolNameMap.get(toolId) || event.toolName || 'unknown';
            await handler.onToolResult?.(toolId, toolName, event.toolResult || '');
            break;
          }

          case 'context_usage':
            if (event.contextUsage) await handler.onContextUsage?.(event.contextUsage);
            break;

          case 'plugin_install':
            if (event.pluginInstall) await handler.onPluginInstall?.(event.pluginInstall);
            break;

          case 'notification':
            if (event.notification) await handler.onNotification?.(event.notification);
            break;

          case 'memory_recall':
            if (event.memoryRecall) await handler.onMemoryRecall?.(event.memoryRecall);
            break;

          case 'compaction_start':
            await handler.onCompactionStart?.();
            break;

          case 'compaction_end':
            await handler.onCompactionEnd?.(event.compaction);
            break;

          case 'done':
            await handler.onDone?.();
            break;

          case 'error':
            // 消息可靠性：SDK 错误事件后必发 onDone（让通道能统一发 done 事件）
            // 防止 loading 永久锁住靠 watchdog 兜底
            this.hasError = true;
            try { await handler.onError?.(event.error || ''); } catch (e) { logger.warn('handler.onError failed:', e); }
            try { await handler.onDone?.(); } catch (e) { logger.warn('handler.onDone after error failed:', e); }
            break;
        }
      }
    } catch (err) {
      this.hasError = true;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Stream error:', err);
      try { await handler.onError?.(errorMessage); } catch (e) { logger.warn('handler.onError failed:', e); }
      try { await handler.onDone?.(); } catch (e) { logger.warn('handler.onDone failed:', e); }
    } finally {
      const result: ConsumeResult = {
        sessionId: this.sessionId,
        finalText: this.finalText,
        hasError: this.hasError,
      };
      await handler.onFinally?.(result);
    }
    return {
      sessionId: this.sessionId,
      finalText: this.finalText,
      hasError: this.hasError,
    };
  }
}

/**
 * 创建带默认工具名解析策略的 EventConsumer。
 * 通道可以按需覆盖 resolveToolName。
 */
export function createEventConsumer(options: EventConsumerOptions = {}): EventConsumer {
  return new EventConsumer({
    resolveToolName: resolveDisplayToolName,
    ...options,
  });
}
