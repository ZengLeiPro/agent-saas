import { randomUUID } from 'node:crypto';
import pg from 'pg';

import type { EventAppendContext, EventListOptions, EventListPage, EventStore, PlatformEvent, PlatformEventInput } from './types.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../data/tenants/types.js';

const { Client, Pool } = pg;
const NOTIFY_RANGE_PAGE_LIMIT = 250;
const DEFAULT_POOL_MAX = 6;

// PostgreSQL jsonb 不支持 U+0000；工具仍可能从普通文本文件或命令输出读到 NUL。
// 只在持久化边界把它保存为可见转义文本，避免单条 tool_result 终止整个 run。
function serializeEventForJsonb(event: PlatformEvent): string {
  const serialized = JSON.stringify(event, (_key, value) => (
    typeof value === 'string' && value.includes('\u0000')
      ? value.replaceAll('\u0000', '\\u0000')
      : value
  ));
  if (serialized === undefined) throw new Error('runtime event 无法序列化为 JSON');
  return serialized;
}

export interface PgEventStoreOptions {
  connectionString: string;
  tablePrefix?: string;
  poolMax?: number;
  logger?: {
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * 门禁加固（2026-06-22）：`subscribeAppended` 的可靠性参数。默认值适配生产单进程
 * 场景；chaos 门禁会调短 reconnect/poll 以在秒级验证断线恢复与丢 NOTIFY 补齐。
 */
export interface SubscribeAppendedOptions {
  /** LISTEN 连接断开后首次重连延迟（ms，指数退避起点）。默认 1000。 */
  reconnectDelayMs?: number;
  /** 重连退避上限（ms）。默认 15000。 */
  maxReconnectDelayMs?: number;
  /**
   * 安全轮询周期（ms）：周期性对所有已跟踪会话从水位 drain，兜底"连接没断但单条
   * NOTIFY 丢失"的情况。设 0 关闭。默认 10000。
   */
  safetyPollIntervalMs?: number;
  /** 内存跟踪的会话水位上限（LRU 淘汰）。默认 10000。 */
  maxTrackedSessions?: number;
  /** 单次 drain 分页大小。默认 NOTIFY_RANGE_PAGE_LIMIT(250)。 */
  drainPageLimit?: number;
}

type PgPool = InstanceType<typeof Pool>;

export class PgEventStore implements EventStore {
  /**
   * 同一个 connection pool 上的 read-side 实现（如 `PgRuntimeAuditQuery`）
   * 可以复用 `pool` 和 `eventsTable`，避免为只读路径再开第二份 pool。
   * 仅允许在 runtime 内部访问；外部代码不要直接读写。
   */
  readonly pool: PgPool;
  readonly eventsTable: string;
  private readonly cursorsTable: string;
  private readonly notifyChannel: string;

  constructor(private readonly options: PgEventStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.eventsTable = `${prefix}_events`;
    this.cursorsTable = `${prefix}_event_cursors`;
    this.notifyChannel = `${prefix}_events_notify`;
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolMax ?? DEFAULT_POOL_MAX,
    });
    this.pool.on('error', (err) => {
      this.options.logger?.warn?.('PgEventStore idle client error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async init(): Promise<void> {
    // 门禁加固（2026-06-22）：advisory lock 串行化并发 init，防多进程同时
    // CREATE INDEX IF NOT EXISTS 撞 pg_class 唯一约束（23505）。详见 PgRunStore.init。
    const lockKey = `${this.eventsTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.cursorsTable} (
          session_id TEXT PRIMARY KEY,
          next_sequence BIGINT NOT NULL DEFAULT 1
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
          global_sequence BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          session_sequence BIGINT NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          run_id TEXT,
          tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}', /* 旧事件缺 tenant 时回填 legacy tenant */
          timestamp TIMESTAMPTZ NOT NULL,
          event_json JSONB NOT NULL,
          UNIQUE(session_id, session_sequence)
        )
      `);
      // PR 3 迁移：兼容旧库（在 CREATE 之前已存在的 runtime_events），加 tenant_id 列
      await client.query(`
        ALTER TABLE ${this.eventsTable}
        ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'
      `);
      // UNIQUE(session_id, session_sequence) 已自带同序 btree，不再创建
      // ${this.eventsTable}_session_idx；event_json GIN 历史上 idx_scan=0，也不再创建。
      // 旧库可能仍有 legacy ${this.eventsTable}_run_idx（早期为 run_id 单列），
      // init 阶段不碰它；新库只创建当前查询下推使用的 session_run_idx。
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.eventsTable}_session_run_idx
        ON ${this.eventsTable} (session_id, run_id, session_sequence)
        WHERE run_id IS NOT NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.eventsTable}_type_idx
        ON ${this.eventsTable} (session_id, event_type, session_sequence)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.eventsTable}_tool_call_idx
        ON ${this.eventsTable} ((event_json->>'toolCallId'), session_id, session_sequence)
        WHERE event_json ? 'toolCallId'
      `);
      // PR 3：tenant_id 索引（按组织分页 / 计费 / 审计聚合时用）
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.eventsTable}_tenant_idx
        ON ${this.eventsTable} (tenant_id, timestamp DESC)
      `);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async append(event: PlatformEventInput, ctx?: EventAppendContext): Promise<PlatformEvent> {
    return (await this.appendBatch([event], ctx))[0]!;
  }

  async appendBatch(events: PlatformEventInput[], ctx?: EventAppendContext): Promise<PlatformEvent[]> {
    if (events.length === 0) return [];
    const sessionIds = new Set(events.map((event) => event.sessionId));
    if (sessionIds.size > 1) {
      const appended: PlatformEvent[] = [];
      for (const event of events) appended.push(await this.append(event, ctx));
      return appended;
    }

    const sessionId = events[0]!.sessionId;
    const tenantId = ctx?.tenantId || DEFAULT_TENANT_ID;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ${this.cursorsTable} (session_id, next_sequence)
         VALUES ($1, 1)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId],
      );
      const cursor = await client.query<{ start_sequence: string }>(
        `UPDATE ${this.cursorsTable}
         SET next_sequence = next_sequence + $2
         WHERE session_id = $1
         RETURNING next_sequence - $2 AS start_sequence`,
        [sessionId, events.length],
      );
      const startSequence = Number(cursor.rows[0]?.start_sequence ?? 1);
      const timestamp = new Date().toISOString();
      const fullEvents = events.map((event, index) => ({
        id: randomUUID(),
        timestamp,
        ...event,
        sequence: startSequence + index,
      }) as PlatformEvent & { sequence: number });

      for (const event of fullEvents) {
        await client.query(
          `INSERT INTO ${this.eventsTable}
           (session_id, session_sequence, event_id, event_type, run_id, tenant_id, timestamp, event_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            event.sessionId,
            event.sequence,
            event.id,
            event.type,
            'runId' in event ? event.runId : null,
            tenantId,
            event.timestamp,
            serializeEventForJsonb(event),
          ],
        );
      }

      await client.query('COMMIT');
      await this.notifyAppended(fullEvents).catch((err) => {
        this.options.logger?.warn?.('PgEventStore notify failed after durable append', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return fullEvents;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async list(sessionId: string, options: EventListOptions = {}): Promise<PlatformEvent[]> {
    const excludeTypes = [...new Set(options.excludeTypes ?? [])];
    if (excludeTypes.length > 0) {
      const result = await this.pool.query<{ event_json: PlatformEvent }>(
        `SELECT event_json
         FROM ${this.eventsTable}
         WHERE session_id = $1
           AND event_type <> ALL($2::text[])
         ORDER BY session_sequence ASC`,
        [sessionId, excludeTypes],
      );
      return result.rows.map((row) => normalizeEventJson(row.event_json));
    }
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1
       ORDER BY session_sequence ASC`,
      [sessionId],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async listPage(
    sessionId: string,
    options: { afterCursor?: string; limit?: number; runId?: string; type?: PlatformEvent['type'] } = {},
  ): Promise<EventListPage> {
    const afterSequence = parsePgCursor(options.afterCursor);
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    const result = await this.pool.query<{ event_json: PlatformEvent; session_sequence: string }>(
      `SELECT event_json, session_sequence
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND session_sequence > $2
         AND ($4::text IS NULL OR run_id = $4::text)
         AND ($5::text IS NULL OR event_type = $5::text)
       ORDER BY session_sequence ASC
       LIMIT $3`,
      [sessionId, afterSequence, limit + 1, options.runId ?? null, options.type ?? null],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      events: rows.map((row) => normalizeEventJson(row.event_json)),
      ...(last && result.rows.length > limit ? { nextCursor: String(last.session_sequence) } : {}),
      hasMore: result.rows.length > limit,
    };
  }

  async listAround(sessionId: string, eventId: string, options: { before?: number; after?: number } = {}): Promise<PlatformEvent[]> {
    const before = Math.max(0, options.before ?? 0);
    const after = Math.max(0, options.after ?? 0);
    const anchor = await this.pool.query<{ session_sequence: string }>(
      `SELECT session_sequence FROM ${this.eventsTable}
       WHERE session_id = $1 AND event_id = $2
       LIMIT 1`,
      [sessionId, eventId],
    );
    const sequence = Number(anchor.rows[0]?.session_sequence);
    if (!Number.isFinite(sequence)) return [];
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND session_sequence >= $2
         AND session_sequence <= $3
       ORDER BY session_sequence ASC`,
      [sessionId, Math.max(1, sequence - before), sequence + after],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async listByRun(sessionId: string, runId: string): Promise<PlatformEvent[]> {
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1 AND run_id = $2
       ORDER BY session_sequence ASC`,
      [sessionId, runId],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async listByToolCall(sessionId: string, toolCallId: string): Promise<PlatformEvent[]> {
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND (
           event_json->>'toolCallId' = $2
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements(CASE
               WHEN jsonb_typeof(event_json->'toolCalls') = 'array' THEN event_json->'toolCalls'
               ELSE '[]'::jsonb
             END) AS call
             WHERE call->>'id' = $2
           )
         )
       ORDER BY session_sequence ASC`,
      [sessionId, toolCallId],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async search(
    sessionId: string,
    query: string,
    options: { limit?: number; runId?: string; type?: PlatformEvent['type'] } = {},
  ): Promise<PlatformEvent[]> {
    const needle = query.trim();
    if (!needle) return [];
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 50);
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND ($3::text IS NULL OR run_id = $3::text)
         AND ($4::text IS NULL OR event_type = $4::text)
         AND event_json::text ILIKE '%' || $2 || '%'
       ORDER BY session_sequence ASC
       LIMIT $5`,
      [sessionId, needle, options.runId ?? null, options.type ?? null, limit],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async getById(eventId: string): Promise<PlatformEvent | null> {
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json FROM ${this.eventsTable} WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    return result.rows[0] ? normalizeEventJson(result.rows[0].event_json) : null;
  }

  async listSessionIdsByTenant(tenantId: string): Promise<string[]> {
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM ${this.eventsTable} WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows.map(row => row.session_id);
  }

  async deleteByTenant(tenantId: string): Promise<{ events: number; cursors: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sessions = await client.query<{ session_id: string }>(
        `SELECT DISTINCT session_id FROM ${this.eventsTable} WHERE tenant_id = $1`,
        [tenantId],
      );
      const sessionIds = sessions.rows.map(row => row.session_id);
      const events = await client.query(`DELETE FROM ${this.eventsTable} WHERE tenant_id = $1`, [tenantId]);
      let cursorCount = 0;
      if (sessionIds.length > 0) {
        const cursors = await client.query(
          `DELETE FROM ${this.cursorsTable} WHERE session_id = ANY($1::text[])`,
          [sessionIds],
        );
        cursorCount = cursors.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return { events: events.rowCount ?? 0, cursors: cursorCount };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async notifyAppended(events: Array<PlatformEvent & { sequence: number }>): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [
      this.notifyChannel,
      encodePgEventNotifyPayload(events),
    ]);
  }

  /**
   * Subscribe to events appended by this or other server processes using PG
   * LISTEN/NOTIFY.
   *
   * 门禁加固（2026-06-22）：原实现单 Client 单次 LISTEN，无重连、无断线 catch-up、
   * 无消费水位——LISTEN 连接一断，期间 commit 的事件 NOTIFY 全丢且永不补拉（跨进程
   * silent data loss）。现加三层保证：
   *   1. 每会话消费水位 `delivered`（已投递的最高 session_sequence）。
   *   2. NOTIFY 只作"该会话有新事件"的触发信号；实际投递走 `drainSession`——从水位
   *      之后用 `listPage` 拉全部新事件。所以丢一条 NOTIFY 会被下一条 NOTIFY / 重连 /
   *      安全轮询自动补齐（不漏）；水位严格单调 + `session_sequence > cursor`（不重）。
   *   3. LISTEN 连接 error/end 自动重连（指数退避），重连后对所有已跟踪会话 catch-up；
   *      可选安全轮询周期 drain，兜底"连接没断但单条 NOTIFY 丢"的极端情况。
   * 旧 event-id payload 仍按单事件直投（兼容，不接入水位）。
   *
   * 首会话用 NOTIFY 的 afterCursor 初始化水位，所以只投订阅点之后的事件，不回放历史
   *（与原实现语义一致）。
   */
  async subscribeAppended(
    onEvent: (event: PlatformEvent) => void | Promise<void>,
    options: SubscribeAppendedOptions = {},
  ): Promise<() => Promise<void>> {
    const reconnectBaseDelayMs = options.reconnectDelayMs ?? 1_000;
    const reconnectMaxDelayMs = options.maxReconnectDelayMs ?? 15_000;
    const safetyPollIntervalMs = options.safetyPollIntervalMs ?? 10_000;
    const maxTrackedSessions = options.maxTrackedSessions ?? 10_000;
    const drainPageLimit = options.drainPageLimit ?? NOTIFY_RANGE_PAGE_LIMIT;

    const delivered = new Map<string, number>();
    const draining = new Set<string>();
    const redo = new Set<string>();
    let closed = false;
    let client: InstanceType<typeof Client> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectDelay = reconnectBaseDelayMs;

    // LRU：把会话挪到 Map 末尾并淘汰最旧的，防内存无界增长。
    const touch = (sessionId: string): void => {
      const value = delivered.get(sessionId);
      if (value !== undefined) {
        delivered.delete(sessionId);
        delivered.set(sessionId, value);
      }
      while (delivered.size > maxTrackedSessions) {
        const oldest = delivered.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        delivered.delete(oldest);
      }
    };

    const safeOnEvent = async (event: PlatformEvent): Promise<void> => {
      try {
        await onEvent(event);
      } catch (err) {
        this.options.logger?.warn?.('PgEventStore subscriber onEvent failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // 从水位之后拉全部新事件并投递，严格单调推进水位。per-session 串行（draining
    // guard + redo flag）——并发触发（live NOTIFY / 重连 catch-up / 安全轮询）折叠成
    // 一次顺序 drain，避免重复投递与水位竞争。
    const drainSession = async (sessionId: string): Promise<void> => {
      if (closed) return;
      if (draining.has(sessionId)) {
        redo.add(sessionId);
        return;
      }
      draining.add(sessionId);
      try {
        do {
          redo.delete(sessionId);
          touch(sessionId);
          while (!closed) {
            const after = delivered.get(sessionId) ?? 0;
            const page = await this.listPage(sessionId, { afterCursor: String(after), limit: drainPageLimit });
            if (page.events.length === 0) break;
            for (const event of page.events) {
              await safeOnEvent(event);
              const seq = Number((event as { sequence?: number }).sequence);
              // 投递成功后才推进水位；非法 seq 时容错跳过（不卡死整条流）。
              if (Number.isFinite(seq) && seq > (delivered.get(sessionId) ?? 0)) {
                delivered.set(sessionId, seq);
              }
            }
            if (!page.hasMore) break;
          }
        } while (redo.has(sessionId));
      } catch (err) {
        this.options.logger?.warn?.('PgEventStore subscriber drain failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        draining.delete(sessionId);
      }
    };

    const catchUpAllSessions = (): void => {
      for (const sessionId of [...delivered.keys()]) {
        void drainSession(sessionId);
      }
    };

    const handleNotification = (message: { channel: string; payload?: string | undefined }): void => {
      if (message.channel !== this.notifyChannel || !message.payload) return;
      const decoded = decodePgEventNotifyPayload(message.payload);
      if (decoded.kind === 'eventId') {
        // 兼容旧 payload：单事件直投，不接入水位。
        void (async () => {
          const event = await this.getById(decoded.eventId).catch(() => null);
          if (event) await safeOnEvent(event);
        })();
        return;
      }
      // range payload：首见会话用 afterCursor 初始化水位（只从订阅点之后投，不回放历史）。
      if (!delivered.has(decoded.sessionId)) {
        delivered.set(decoded.sessionId, parsePgCursor(decoded.afterCursor));
      }
      void drainSession(decoded.sessionId);
    };

    const teardownClient = (target: InstanceType<typeof Client> | null): void => {
      if (!target) return;
      target.removeAllListeners('notification');
      target.removeAllListeners('error');
      target.removeAllListeners('end');
      target.end().catch(() => undefined);
    };

    const connectOnce = async (): Promise<void> => {
      const next = new Client({ connectionString: this.options.connectionString });
      next.on('error', (err) => {
        this.options.logger?.warn?.('PgEventStore listener error', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (client === next) scheduleReconnect();
      });
      next.on('end', () => {
        if (!closed && client === next) scheduleReconnect();
      });
      next.on('notification', handleNotification);
      await next.connect();
      await next.query(`LISTEN ${this.notifyChannel}`);
      client = next;
      reconnectDelay = reconnectBaseDelayMs;
      // (重)连接后对所有已跟踪会话 catch-up，补回断线窗口内 commit 的事件。
      catchUpAllSessions();
    };

    const scheduleReconnect = (): void => {
      if (closed || reconnectTimer) return;
      const failed = client;
      client = null;
      teardownClient(failed);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closed) return;
        connectOnce().catch((err) => {
          this.options.logger?.warn?.('PgEventStore listener reconnect failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxDelayMs);
          scheduleReconnect();
        });
      }, reconnectDelay);
      reconnectTimer.unref?.();
    };

    // 初次连接：失败直接抛（保留原启动语义，让配置错误在启动期暴露）。
    await connectOnce();

    if (safetyPollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        if (closed) return;
        catchUpAllSessions();
      }, safetyPollIntervalMs);
      pollTimer.unref?.();
    }

    return async () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      const active = client;
      client = null;
      if (active) {
        await active.query(`UNLISTEN ${this.notifyChannel}`).catch(() => undefined);
        teardownClient(active);
      }
    };
  }
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`非法 PG tablePrefix: ${value}`);
  }
  return value;
}

function parsePgCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeEventJson(raw: PlatformEvent | string): PlatformEvent {
  return typeof raw === 'string' ? JSON.parse(raw) as PlatformEvent : raw;
}

export interface PgEventNotifyRangePayload {
  v: 1;
  type: 'event_range';
  sessionId: string;
  afterCursor: string;
  fromCursor: string;
  toCursor: string;
  count: number;
}

export type PgEventNotifyDecodedPayload =
  | {
    kind: 'range';
    sessionId: string;
    afterCursor: string;
    fromCursor: string;
    toCursor: string;
    count: number;
  }
  | { kind: 'eventId'; eventId: string };

export function encodePgEventNotifyPayload(events: Array<PlatformEvent & { sequence: number }>): string {
  if (events.length === 0) {
    throw new Error('cannot encode empty PgEventStore notification payload');
  }
  const first = events[0]!;
  const last = events[events.length - 1]!;
  if (!first.sessionId) {
    throw new Error('cannot encode PgEventStore notification payload without sessionId');
  }
  return JSON.stringify({
    v: 1,
    type: 'event_range',
    sessionId: first.sessionId,
    afterCursor: String(first.sequence - 1),
    fromCursor: String(first.sequence),
    toCursor: String(last.sequence),
    count: events.length,
  } satisfies PgEventNotifyRangePayload);
}

export function decodePgEventNotifyPayload(payload: string): PgEventNotifyDecodedPayload {
  try {
    const parsed = JSON.parse(payload) as Partial<PgEventNotifyRangePayload>;
    if (
      parsed
      && parsed.v === 1
      && parsed.type === 'event_range'
      && typeof parsed.sessionId === 'string'
      && parsed.sessionId.length > 0
      && typeof parsed.afterCursor === 'string'
      && typeof parsed.fromCursor === 'string'
      && typeof parsed.toCursor === 'string'
      && typeof parsed.count === 'number'
      && Number.isInteger(parsed.count)
      && parsed.count > 0
      && isPositiveCursor(parsed.fromCursor)
      && isPositiveCursor(parsed.toCursor)
      && parsePgCursor(parsed.toCursor) >= parsePgCursor(parsed.fromCursor)
      && parsed.count === parsePgCursor(parsed.toCursor) - parsePgCursor(parsed.fromCursor) + 1
    ) {
      return {
        kind: 'range',
        sessionId: parsed.sessionId,
        afterCursor: parsed.afterCursor,
        fromCursor: parsed.fromCursor,
        toCursor: parsed.toCursor,
        count: parsed.count,
      };
    }
  } catch {
    // Legacy payloads are raw event ids, not JSON.
  }
  return { kind: 'eventId', eventId: payload };
}

function isPositiveCursor(value: string): boolean {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && String(parsed) === value;
}
