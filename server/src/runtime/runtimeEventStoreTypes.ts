import type { PlatformEvent } from './types.js';

export type PlatformEventInput = PlatformEvent extends infer Event
  ? Event extends PlatformEvent
    ? Omit<Event, 'id' | 'timestamp'> & { id?: string }
    : never
  : never;

export interface EventListPage {
  events: PlatformEvent[];
  /**
   * Opaque cursor for the next page. File backend uses a line offset; PG backend
   * uses session-local sequence. Callers must not parse this outside tests.
   */
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * EventStore 的强制租户写入边界。tenantId 不进入 PlatformEvent union，而由
 * store 行级元数据保存；调用方必须显式提供，禁止 backend 静默回退默认租户。
 */
export interface EventAppendContext {
  tenantId: string;
}

export interface EventListOptions {
  /**
   * 仅用于 run 启动前的上下文/状态重放瘦身。断线重连的 durable replay 不传该参数，
   * 仍按 EventStore 事实源全量补齐工具输出中间段。
   */
  excludeTypes?: PlatformEvent['type'][];
  /** 只读取指定类型；用于 wake/approval 状态判断，避免把无关的大事件载入 Node。 */
  includeTypes?: PlatformEvent['type'][];
  /**
   * 模型/恢复回放视图：工具原文仍留在 EventStore，读取边界只返回有界 content。
   * 生产 PG backend 在 SQL 内截断，避免先把大字段送进 Node 再做内存截断。
   */
  replayMode?: 'bounded';
  /**
   * 统计视图：只保留 usage/model/contextBreakdown 等计量字段，移除事件正文。
   * PG backend 必须在 SQL 内完成投影，避免先把大 content 送入 Node。
   */
  projection?: 'usage';
}

export interface EventStore {
  append(event: PlatformEventInput, ctx: EventAppendContext): Promise<PlatformEvent>;
  appendBatch?(events: PlatformEventInput[], ctx: EventAppendContext): Promise<PlatformEvent[]>;
  list(tenantId: string, sessionId: string, options?: EventListOptions): Promise<PlatformEvent[]>;
  listPage?(tenantId: string, sessionId: string, options?: {
    afterCursor?: string;
    limit?: number;
    runId?: string;
    type?: PlatformEvent['type'];
    excludeTypes?: PlatformEvent['type'][];
    projection?: 'usage';
  }): Promise<EventListPage>;
  listAround?(tenantId: string, sessionId: string, eventId: string, options?: { before?: number; after?: number }): Promise<PlatformEvent[]>;
  listByRun?(tenantId: string, sessionId: string, runId: string): Promise<PlatformEvent[]>;
  listByToolCall?(tenantId: string, sessionId: string, toolCallId: string): Promise<PlatformEvent[]>;
  search?(tenantId: string, sessionId: string, query: string, options?: {
    limit?: number;
    runId?: string;
    type?: PlatformEvent['type'];
    excludeTypes?: PlatformEvent['type'][];
  }): Promise<PlatformEvent[]>;
  getById?(tenantId: string, eventId: string): Promise<PlatformEvent | null>;
}
