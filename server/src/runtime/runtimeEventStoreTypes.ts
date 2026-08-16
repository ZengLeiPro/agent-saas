import type { PlatformEvent } from './types.js';

export type PlatformEventInput = PlatformEvent extends infer Event
  ? Event extends PlatformEvent
    ? Omit<Event, 'id' | 'timestamp'>
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
 * 多组织改造 PR 3：所有 append 路径可选携带 tenantId（不进 PlatformEvent union
 * 类型，避免 18 个分支的 invasive 改动）。PG backend 写入 tenant_id 列；File
 * backend 忽略（jsonl 旁路文件物理隔离）。未传时 fallback 平台根组织。
 *
 * 调用方接通节奏：
 *   - PR 3 仅 store 层接口扩；调用方暂不强制传，旧数据迁移统一按 legacy tenant 回填
 *   - PR 4 dispatch/channel 把 user.tenantId 一路传到 append（真正按组织落库）
 */
export interface EventAppendContext {
  tenantId?: string;
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
  append(event: PlatformEventInput, ctx?: EventAppendContext): Promise<PlatformEvent>;
  appendBatch?(events: PlatformEventInput[], ctx?: EventAppendContext): Promise<PlatformEvent[]>;
  list(sessionId: string, options?: EventListOptions): Promise<PlatformEvent[]>;
  listPage?(sessionId: string, options?: {
    afterCursor?: string;
    limit?: number;
    runId?: string;
    type?: PlatformEvent['type'];
    excludeTypes?: PlatformEvent['type'][];
    projection?: 'usage';
  }): Promise<EventListPage>;
  listAround?(sessionId: string, eventId: string, options?: { before?: number; after?: number }): Promise<PlatformEvent[]>;
  listByRun?(sessionId: string, runId: string): Promise<PlatformEvent[]>;
  listByToolCall?(sessionId: string, toolCallId: string): Promise<PlatformEvent[]>;
  search?(sessionId: string, query: string, options?: {
    limit?: number;
    runId?: string;
    type?: PlatformEvent['type'];
    excludeTypes?: PlatformEvent['type'][];
  }): Promise<PlatformEvent[]>;
  getById?(eventId: string): Promise<PlatformEvent | null>;
}
