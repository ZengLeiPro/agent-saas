/**
 * Per-User Metadata Event Log
 *
 * 轻量级内存环形缓冲，仅存储跨会话的元数据事件（title_updated、session_updated、
 * session_deleted、groups_changed、session_status 等）。
 *
 * 用途：WS 断线重连时，客户端发送 { action: 'sync', lastSeq } ，
 * 服务端从日志中回放漏掉的元数据事件，避免全量 loadSessions() HTTP 请求。
 */

/** 元数据事件类型白名单 */
const METADATA_EVENT_TYPES = new Set([
  'title_updated',
  'session_updated',
  'session_deleted',
  'session_status',
  'groups_changed',
  'stream_started',
  'interaction_resolved',
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
  private logs = new Map<string, UserLog>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

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

  /** 推送一条元数据事件到用户日志，返回分配的 seq */
  push(userId: string, event: object): number {
    let log = this.logs.get(userId);
    if (!log) {
      log = { events: [], nextSeq: 1, lastAccessAt: Date.now() };
      this.logs.set(userId, log);
    }

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
      return { events: [], gapDetected: false };
    }

    log.lastAccessAt = Date.now();

    const oldestSeq = log.events[0].seq;

    // 客户端已经是最新的
    if (lastSeq >= log.nextSeq - 1) {
      return { events: [], gapDetected: false };
    }

    // 检测 gap：客户端的 lastSeq 比日志中最老的还老
    const gapDetected = lastSeq > 0 && lastSeq < oldestSeq - 1;

    // 返回 lastSeq 之后的所有事件
    const events = log.events.filter(e => e.seq > lastSeq);
    return { events, gapDetected };
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
