/**
 * Per-User Metadata Event Log
 *
 * 轻量级内存环形缓冲，仅存储跨会话的元数据事件（title_updated、session_updated、
 * session_deleted、groups_changed、session_status 等）。
 *
 * 用途：WS 断线重连时，客户端发送 { action: 'sync', lastSeq } ，
 * 服务端从日志中回放漏掉的元数据事件，避免全量 loadSessions() HTTP 请求。
 */

import { randomUUID } from 'node:crypto';

/** 元数据事件类型白名单 */
const METADATA_EVENT_TYPES = new Set([
  'title_updated',
  'session_updated',
  'session_deleted',
  'session_read_state_changed',
  'session_status',
  'groups_changed',
  'tenant_features_changed',
  'stream_started',
  'interaction_resolved',
  'message_queued',
  'queue_item_updated',
  'steering_queued',
  'steering_cancelled',
]);

export interface UserEvent {
  seq: number;
  timestamp: number;
  event: object;
}

interface UserLog {
  events: UserEvent[];
  nextSeq: number;
  lastAccessAt: number;
}

const MAX_EVENTS_PER_USER = 200;
const LOG_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

export class UserEventLog {
  /** 当前服务进程的权威代际；单实例生命周期内稳定，进程重启后变化。 */
  readonly epoch: string;
  private logs = new Map<string, UserLog>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(epoch: string = randomUUID()) {
    this.epoch = epoch;
  }

  /** 获取服务进程代际；userId 保留在签名中以兼容现有调用方。 */
  getEpoch(_userId: string): string {
    return this.epoch;
  }

  /** lastSeq=0 是首次同步；其余请求必须证明来自当前用户日志代际。 */
  hasEpochMismatch(userId: string, clientEpoch: string | undefined, lastSeq: number): boolean {
    return lastSeq > 0 && clientEpoch !== this.getEpoch(userId);
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.logs.clear();
  }

  /** 判断事件是否应该记录到元数据日志 */
  shouldLog(event: object): boolean {
    return 'type' in event && METADATA_EVENT_TYPES.has((event as { type: string }).type);
  }

  private getOrCreateLog(userId: string): UserLog {
    let log = this.logs.get(userId);
    if (!log) {
      log = { events: [], nextSeq: 1, lastAccessAt: Date.now() };
      this.logs.set(userId, log);
    } else {
      log.lastAccessAt = Date.now();
    }
    return log;
  }

  /** 推送一条元数据事件到用户日志，返回分配的 seq */
  push(userId: string, event: object): number {
    const log = this.getOrCreateLog(userId);

    const seq = log.nextSeq++;
    log.lastAccessAt = Date.now();
    log.events.push({ seq, timestamp: Date.now(), event });

    // 环形缓冲：超出容量时移除最老的事件
    if (log.events.length > MAX_EVENTS_PER_USER) {
      log.events.shift();
    }

    return seq;
  }

  /** 获取 lastSeq 之后的所有事件。如果有 gap 则返回 gapDetected: true */
  getEventsAfter(userId: string, lastSeq: number): { events: UserEvent[]; gapDetected: boolean } {
    const log = this.logs.get(userId);
    if (!log || log.events.length === 0) {
      return { events: [], gapDetected: lastSeq > 0 };
    }

    log.lastAccessAt = Date.now();

    const oldestSeq = log.events[0].seq;
    const currentSeq = log.nextSeq - 1;

    // 客户端 seq 超前说明服务端日志来自重启后的新实例/其它副本，必须全量恢复
    if (lastSeq > currentSeq) {
      return { events: [], gapDetected: true };
    }

    // 客户端已经是最新的
    if (lastSeq === currentSeq) {
      return { events: [], gapDetected: false };
    }

    // lastSeq=0 也必须覆盖 seq=1；保留窗口不完整时明确 overflow。
    const gapDetected = lastSeq < oldestSeq - 1;
    if (gapDetected) return { events: [], gapDetected: true };

    const events = log.events.filter(e => e.seq > lastSeq);
    // 防御性连续性校验：绝不把稀疏窗口伪装成连续回放。
    let expectedSeq = lastSeq + 1;
    for (const entry of events) {
      if (entry.seq !== expectedSeq) return { events: [], gapDetected: true };
      expectedSeq += 1;
    }
    if (events.length > 0 && events.at(-1)!.seq !== currentSeq) {
      return { events: [], gapDetected: true };
    }
    return { events, gapDetected: false };
  }

  /** 获取用户当前的最大 seq */
  getCurrentSeq(userId: string): number {
    const log = this.logs.get(userId);
    return log ? log.nextSeq - 1 : 0;
  }

  /** 清理过期的用户日志 */
  private cleanup(): void {
    const now = Date.now();
    for (const [userId, log] of this.logs) {
      if (now - log.lastAccessAt > LOG_TTL_MS) {
        this.logs.delete(userId);
      }
    }
  }
}
