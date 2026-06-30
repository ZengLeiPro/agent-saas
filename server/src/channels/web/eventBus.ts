/**
 * EventBus — 中央事件总线
 *
 * 所有 WS 下行事件的唯一出口。根据 EVENT_SCOPE 声明表自动路由到
 * 对应的缓冲策略（EventBuffer / UserEventLog）和推送范围。
 *
 * 设计原则：
 * - 调用方只需知道"发什么事件"，不需要知道"走哪条通道"
 * - 事件类型 → 作用域的映射是静态声明的，IDE 可查、编译期可检查
 * - 内部复用现有 EventBufferStore 和 UserEventLog，不替代它们
 */

import type { WebSocket } from 'ws';
import type { EventBufferStore } from './eventBuffer.js';
import type { UserEventLog } from './userEventLog.js';
import type { WsClient } from './wsServer.js';

// ── 事件作用域 ──────────────────────────────────────────────

export type EventScope = 'session' | 'user' | 'dual' | 'admin' | 'reply';

/**
 * 事件类型 → 作用域的静态声明表
 *
 * - session: 流式内容 → 只写 EventBuffer，isActive 守卫直推发起方
 * - user:    跨会话通知 → 只写 UserEventLog，广播携带 seq
 * - dual:    会话元数据 → 双写 EventBuffer + UserEventLog，广播携带 seq
 * - reply:   请求响应 → 直发不存储
 *
 * 新增事件类型必须在此注册。
 */
export const EVENT_SCOPE: Record<string, EventScope> = {
  // ── session scope: 流式内容 ──
  stream_id: 'session',
  session: 'session',
  block_start: 'session',
  thinking: 'session',
  text: 'session',
  tool_input: 'session',
  block_end: 'session',
  tool_result: 'session',
  permission_request: 'session',
  ask_user: 'session',
  subagent_start: 'session',
  subagent_end: 'session',
  file_download: 'session',
  voice: 'session',
  user_message: 'session',
  done: 'session',
  error: 'session',

  // ── user scope: 跨会话通知 ──
  session_deleted: 'user',
  groups_changed: 'user',

  // ── SDK 0.2.112+ 新增事件 ──
  context_usage: 'session',
  plugin_install: 'session',
  memory_recall: 'session',
  // notification 是 REPL 级 UI 通知，跨会话展示
  notification: 'user',

  // ── dual scope: 需要双写 EventBuffer + UserEventLog 的事件 ──
  // （通过 emitDual 发射，保证 EventBuffer 中与 done 的顺序 + UserEventLog 供 sync 回放）
  session_updated: 'dual',
  title_updated: 'dual',

  // ── user scope: 通知类元数据（只写 UserEventLog，不需要进 EventBuffer）──
  session_status: 'user',
  stream_started: 'user',
  interaction_resolved: 'user',

  // ── reply scope: 请求响应（直发不存储）──
  respond_ok: 'reply',
  respond_error: 'reply',
  abort_ok: 'reply',
  voice_transcribed: 'reply',
  active_stream: 'reply',
  pending_interactions: 'reply',
  buffer_overflow: 'reply',
  sync_ok: 'reply',
  sync_overflow: 'reply',
  pong: 'reply',
  // 消息可靠性协议（2026-04-18 新增）
  // chat_ack / chat_rejected 仅反馈给发起方，不持久化、不跨设备
  chat_ack: 'reply',
  chat_rejected: 'reply',
};

// ── 类型 ──────────────────────────────────────────────────

/** emitSession 的会话上下文（由 handleEvents 闭包持有） */
export interface SessionContext {
  sessionId: string;
  streamId: string;
  ws: WebSocket;
  userId?: string;
}

export interface EventBusConfig {
  eventBufferStore: EventBufferStore;
  userEventLog: UserEventLog;
  getClientsByUser: (userId: string) => Set<WsClient> | undefined;
  getAdminUserIds: () => string[];
  sendTo: (ws: WebSocket, envelope: object) => void;
  isActiveStream: (ws: WebSocket, streamId: string) => boolean;
}

// ── EventBus ──────────────────────────────────────────────

export class EventBus {
  constructor(private readonly config: EventBusConfig) {}

  /**
   * 发射会话内事件（session/dual scope）
   * 替代 handleEvents 内的 send() 闭包
   */
  emitSession(ctx: SessionContext, data: object): void {
    // 写入 EventBuffer
    const json = JSON.stringify(data);
    const eventId = ctx.sessionId
      ? this.config.eventBufferStore.push(ctx.sessionId, json)
      : null;

    // 直推给发起方（如果仍活跃）
    if (ctx.ws.readyState === ctx.ws.OPEN
      && this.config.isActiveStream(ctx.ws, ctx.streamId)) {
      if (eventId !== null) {
        this.config.sendTo(ctx.ws, { eventId, data });
      } else {
        this.config.sendTo(ctx.ws, { data });
      }
    }
    // 注意：dual scope 事件不应通过 emitSession 发送，应使用 emitDual。
    // emitSession 只处理 session scope（流式内容），不写 UserEventLog。
  }

  /**
   * 发射用户级事件（user/dual scope，无 EventBuffer 上下文）
   * 替代所有 broadcastToUser 调用
   */
  emitUser(userId: string, data: object, excludeWs?: WebSocket): void {
    const seq = this.config.userEventLog.push(userId, data);
    this.broadcastWithSeq(userId, data, seq, excludeWs);
  }

  /**
   * 发射双作用域事件（有 sessionId + userId）
   * 用于 onDone 等场景：事件需要同时进 EventBuffer（保排序）和 UserEventLog（保列表更新）
   */
  emitDual(userId: string, sessionId: string, data: object, excludeWs?: WebSocket): void {
    // 先写 EventBuffer（保证与 done 等事件的顺序）
    const json = JSON.stringify(data);
    this.config.eventBufferStore.push(sessionId, json);

    // 再写 UserEventLog + 广播
    const seq = this.config.userEventLog.push(userId, data);
    this.broadcastWithSeq(userId, data, seq, excludeWs);
  }

  /**
   * 发射 admin 事件
   * 替代 broadcastToAdmin（遍历 admin 用户）
   * 只有白名单内的事件才写入 UserEventLog（高频的 log_line/cost_update 只广播不持久化）
   */
  emitAdmin(data: object): void {
    const adminIds = this.config.getAdminUserIds();
    const shouldPersist = this.config.userEventLog.shouldLog(data);
    for (const userId of adminIds) {
      if (shouldPersist) {
        const seq = this.config.userEventLog.push(userId, data);
        this.broadcastWithSeq(userId, data, seq);
      } else {
        // 高频事件：只广播不持久化，不带 seq
        this.broadcastRaw(userId, data);
      }
    }
  }

  /**
   * 发射 reply 事件（点对点，不存储）
   * 替代 wsSend
   */
  emitReply(ws: WebSocket, data: object, eventId?: number): void {
    if (ws.readyState === ws.OPEN) {
      this.config.sendTo(ws, eventId !== undefined ? { eventId, data } : { data });
    }
  }

  // ── 内部方法 ──────────────────────────────────────────

  /** 广播并在 envelope 中携带 seq（供前端 gap 检测） */
  private broadcastWithSeq(userId: string, data: object, seq: number, excludeWs?: WebSocket): void {
    const clients = this.config.getClientsByUser(userId);
    if (!clients) return;
    const envelope = { seq, data };
    for (const client of clients) {
      if (client.ws !== excludeWs && client.ws.readyState === client.ws.OPEN) {
        this.config.sendTo(client.ws, envelope);
      }
    }
  }

  /** 广播不携带 seq（用于高频非持久化事件） */
  private broadcastRaw(userId: string, data: object, excludeWs?: WebSocket): void {
    const clients = this.config.getClientsByUser(userId);
    if (!clients) return;
    for (const client of clients) {
      if (client.ws !== excludeWs && client.ws.readyState === client.ws.OPEN) {
        this.config.sendTo(client.ws, { data });
      }
    }
  }
}
