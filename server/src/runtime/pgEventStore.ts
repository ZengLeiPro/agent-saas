import { randomUUID } from 'node:crypto';
import pg from 'pg';

import type { EventAppendContext, EventListOptions, EventListPage, EventStore, PlatformEvent, PlatformEventInput } from './types.js';
import {
  projectToolResultSourceForModel,
  TOOL_RESULT_PROJECTION_PREFIX_CHARS,
  TOOL_RESULT_PROJECTION_SUFFIX_CHARS,
} from './replayEventBounds.js';
import { encodePgEventNotifyPayload, lockPgEventGlobalSequence, parsePgCursor } from './pgEventStoreProtocol.js';
import { allocatePgEventSequences } from './pgEventCursorAllocator.js';
import { applyPgEventStoreSchema } from './pgEventStoreSchema.js';
export { decodePgEventNotifyPayload, encodePgEventNotifyPayload } from './pgEventStoreProtocol.js';

const { Client, Pool } = pg;
const NOTIFY_RANGE_PAGE_LIMIT = 250;
// PgSessionLock 已迁为短查询表租约，不再按 active session 常驻占连接。
// 默认 6 给事件 append/投影/运行状态等并发短事务留出余量；显式配置仍可覆盖。
const DEFAULT_POOL_MAX = 6;
const PG_TOO_MANY_CONNECTIONS = '53300';

function isPgConnectionCapacityError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: unknown }).code === PG_TOO_MANY_CONNECTIONS;
}

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
   * 安全轮询周期（ms）：周期性从 durable global_sequence 水位 drain，兜底"连接没断但
   * NOTIFY 丢失"的情况。设 0 关闭。默认 10000。
   */
  safetyPollIntervalMs?: number;
  /** @deprecated 全局水位不再需要按 session 跟踪；保留字段仅兼容旧配置。 */
  maxTrackedSessions?: number;
  /** 单次全局 drain 分页大小。默认 NOTIFY_RANGE_PAGE_LIMIT(250)。 */
  drainPageLimit?: number;
}

type PgPool = InstanceType<typeof Pool>;
type PgPoolClient = pg.PoolClient;

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

  private async queryWithEventsShareLock<Row extends pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<Row>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // SHARE conflicts with the ROW EXCLUSIVE lock held by INSERT. PostgreSQL's lock queue also
      // keeps later INSERTs behind this pending/granted reader until the SELECT snapshot is read.
      await client.query(`LOCK TABLE ${this.eventsTable} IN SHARE MODE`);
      const result = await client.query<Row>(text, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async init(): Promise<void> {
    // 门禁加固（2026-06-22）：advisory lock 串行化并发 init，防多进程同时
    // CREATE INDEX IF NOT EXISTS 撞 pg_class 唯一约束（23505）。详见 PgRunStore.init。
    const lockKey = `${this.eventsTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query('BEGIN');
      await applyPgEventStoreSchema(client, this.eventsTable, this.cursorsTable);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async append(event: PlatformEventInput, ctx: EventAppendContext): Promise<PlatformEvent> {
    return (await this.appendBatch([event], ctx))[0]!;
  }

  async appendBatch(events: PlatformEventInput[], ctx: EventAppendContext): Promise<PlatformEvent[]> {
    const tenantId = requireTenantId(ctx.tenantId);
    if (events.length === 0) return [];
    const sessionIds = new Set(events.map((event) => event.sessionId));
    if (sessionIds.size > 1) {
      const appended: PlatformEvent[] = [];
      for (const event of events) appended.push(await this.append(event, ctx));
      return appended;
    }

    const sessionId = events[0]!.sessionId;
    if (!sessionId) throw new Error('Runtime event append requires a session');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Keep new writers commit-ordered as an optimization; read-side SHARE locking below is the
      // compatibility guarantee for rolling-deploy writers that do not take this advisory lock.
      await lockPgEventGlobalSequence(client, this.eventsTable);
      const startSequence = await allocatePgEventSequences(
        client,
        this.cursorsTable,
        tenantId,
        sessionId,
        events.length,
      );
      const timestamp = new Date().toISOString();
      const fullEvents = events.map((event, index) => ({
        id: event.id ?? randomUUID(),
        timestamp,
        ...event,
        sequence: startSequence + index,
      }) as PlatformEvent & { sequence: number });
      const durableEvents: PlatformEvent[] = [];
      const newlyAppended: Array<PlatformEvent & { sequence: number }> = [];

      for (const event of fullEvents) {
        const inserted = await client.query<{ event_json: PlatformEvent }>(
          `INSERT INTO ${this.eventsTable}
           (session_id, session_sequence, event_id, event_type, run_id, tenant_id, timestamp, event_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT (tenant_id, event_id) DO NOTHING
           RETURNING event_json`,
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
        if (inserted.rows[0]) {
          durableEvents.push(normalizeEventJson(inserted.rows[0].event_json));
          newlyAppended.push(event);
          continue;
        }
        const existing = await client.query<{ event_json: PlatformEvent }>(
          `SELECT event_json FROM ${this.eventsTable} WHERE tenant_id = $1 AND event_id = $2`,
          [tenantId, event.id],
        );
        if (!existing.rows[0]) throw new Error(`Event idempotency lookup failed: ${event.id}`);
        durableEvents.push(normalizeEventJson(existing.rows[0].event_json));
      }

      await client.query('COMMIT');
      // 复用当前已 COMMIT 的 client，禁止在归还它之前再次向同一 pool 取连接。
      // 否则 active session locks 占满部分 pool 后，多条并发 append 会各自拿着
      // transaction client 等 pg_notify 的第二条连接，形成确定性 pool deadlock。
      await this.notifyAppended(client, newlyAppended).catch((err) => {
        this.options.logger?.warn?.('PgEventStore notify failed after durable append', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return durableEvents;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async list(tenantId: string, sessionId: string, options: EventListOptions = {}): Promise<PlatformEvent[]> {
    tenantId = requireTenantId(tenantId);
    const excludeTypes = [...new Set(options.excludeTypes ?? [])];
    const includeTypes = [...new Set(options.includeTypes ?? [])];
    if (options.projection === 'usage') {
      const result = await this.pool.query<{ event_json: PlatformEvent }>(
        `SELECT event_json - 'content' - 'modelContent' AS event_json
         FROM ${this.eventsTable}
         WHERE session_id = $1
           AND tenant_id = $5
           AND ($2::boolean = false OR event_type = ANY($3::text[]))
           AND event_type <> ALL($4::text[])
         ORDER BY session_sequence ASC`,
        [sessionId, includeTypes.length > 0, includeTypes, excludeTypes, tenantId],
      );
      return result.rows.map((row) => normalizeEventJson(row.event_json));
    }
    if (options.replayMode === 'bounded') {
      const result = await this.pool.query<{
        event_json: PlatformEvent;
        tool_content_prefix: string | null;
        tool_content_suffix: string | null;
        tool_content_chars: string | number | null;
        tool_content_lines: string | number | null;
      }>(
        `SELECT CASE
                  WHEN event_type = 'tool_result'
                    AND jsonb_typeof(event_json -> 'content') = 'string'
                  THEN event_json - 'content' - 'modelContent'
                  ELSE event_json
                END AS event_json,
                CASE
                  WHEN event_type = 'tool_result'
                    AND jsonb_typeof(event_json -> 'content') = 'string'
                  THEN left(event_json ->> 'content', $5::integer)
                  ELSE NULL
                END AS tool_content_prefix,
                CASE
                  WHEN event_type = 'tool_result'
                    AND jsonb_typeof(event_json -> 'content') = 'string'
                  THEN right(event_json ->> 'content', $6::integer)
                  ELSE NULL
                END AS tool_content_suffix,
                CASE
                  WHEN event_type = 'tool_result'
                    AND jsonb_typeof(event_json -> 'content') = 'string'
                  THEN char_length(event_json ->> 'content')
                  ELSE NULL
                END AS tool_content_chars,
                CASE
                  WHEN event_type = 'tool_result'
                    AND jsonb_typeof(event_json -> 'content') = 'string'
                  THEN 1 + char_length(event_json ->> 'content')
                    - char_length(replace(event_json ->> 'content', E'\\n', ''))
                  ELSE NULL
                END AS tool_content_lines
         FROM ${this.eventsTable}
         WHERE session_id = $1
           AND tenant_id = $7
           AND ($2::boolean = false OR event_type = ANY($3::text[]))
           AND event_type <> ALL($4::text[])
         ORDER BY session_sequence ASC`,
        [
          sessionId,
          includeTypes.length > 0,
          includeTypes,
          excludeTypes,
          TOOL_RESULT_PROJECTION_PREFIX_CHARS,
          TOOL_RESULT_PROJECTION_SUFFIX_CHARS,
          tenantId,
        ],
      );
      return result.rows.map((row) => {
        if (
          typeof row.tool_content_prefix !== 'string'
          || typeof row.tool_content_suffix !== 'string'
          || row.tool_content_chars == null
          || row.tool_content_lines == null
        ) {
          return normalizeEventJson(row.event_json);
        }
        const event = normalizeEventJson(row.event_json);
        if (event.type !== 'tool_result') return event;
        return {
          ...event,
          content: projectToolResultSourceForModel({
            prefix: row.tool_content_prefix,
            suffix: row.tool_content_suffix,
            totalChars: Number(row.tool_content_chars),
            totalLines: Number(row.tool_content_lines),
          }, event.toolCallId),
        };
      });
    }
    if (includeTypes.length > 0) {
      const result = await this.pool.query<{ event_json: PlatformEvent }>(
        `SELECT event_json
         FROM ${this.eventsTable}
         WHERE session_id = $1
           AND tenant_id = $4
           AND event_type = ANY($2::text[])
           AND event_type <> ALL($3::text[])
         ORDER BY session_sequence ASC`,
        [sessionId, includeTypes, excludeTypes, tenantId],
      );
      return result.rows.map((row) => normalizeEventJson(row.event_json));
    }
    if (excludeTypes.length > 0) {
      const result = await this.pool.query<{ event_json: PlatformEvent }>(
        `SELECT event_json
         FROM ${this.eventsTable}
         WHERE session_id = $1
           AND tenant_id = $3
           AND event_type <> ALL($2::text[])
         ORDER BY session_sequence ASC`,
        [sessionId, excludeTypes, tenantId],
      );
      return result.rows.map((row) => normalizeEventJson(row.event_json));
    }
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1 AND tenant_id = $2
       ORDER BY session_sequence ASC`,
      [sessionId, tenantId],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async listPage(
    tenantId: string,
    sessionId: string,
    options: {
      afterCursor?: string;
      limit?: number;
      runId?: string;
      type?: PlatformEvent['type'];
      excludeTypes?: PlatformEvent['type'][];
      projection?: 'usage';
    } = {},
  ): Promise<EventListPage> {
    tenantId = requireTenantId(tenantId);
    const afterSequence = parsePgCursor(options.afterCursor);
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    const excludeTypes = [...new Set(options.excludeTypes ?? [])];
    const eventJsonProjection = options.projection === 'usage'
      ? "event_json - 'content' - 'modelContent'"
      : 'event_json';
    const result = await this.pool.query<{ event_json: PlatformEvent; session_sequence: string }>(
      `SELECT ${eventJsonProjection} AS event_json, session_sequence
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND tenant_id = $7
         AND session_sequence > $2
         AND ($4::text IS NULL OR run_id = $4::text)
         AND ($5::text IS NULL OR event_type = $5::text)
         AND event_type <> ALL($6::text[])
       ORDER BY session_sequence ASC
       LIMIT $3`,
      [sessionId, afterSequence, limit + 1, options.runId ?? null, options.type ?? null, excludeTypes, tenantId],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      events: rows.map((row) => normalizeEventJson(row.event_json)),
      ...(last && result.rows.length > limit ? { nextCursor: String(last.session_sequence) } : {}),
      hasMore: result.rows.length > limit,
    };
  }

  async listAround(tenantId: string, sessionId: string, eventId: string, options: { before?: number; after?: number } = {}): Promise<PlatformEvent[]> {
    tenantId = requireTenantId(tenantId);
    const before = Math.max(0, options.before ?? 0);
    const after = Math.max(0, options.after ?? 0);
    const anchor = await this.pool.query<{ session_sequence: string }>(
      `SELECT session_sequence FROM ${this.eventsTable}
       WHERE session_id = $1 AND event_id = $2 AND tenant_id = $3
       LIMIT 1`,
      [sessionId, eventId, tenantId],
    );
    const sequence = Number(anchor.rows[0]?.session_sequence);
    if (!Number.isFinite(sequence)) return [];
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND tenant_id = $4
         AND session_sequence >= $2
         AND session_sequence <= $3
       ORDER BY session_sequence ASC`,
      [sessionId, Math.max(1, sequence - before), sequence + after, tenantId],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  /**
   * 全局游标分页（2026-07-29 L2 记忆整合批次）：按 global_sequence 升序读取
   * run 边界事件，供 consolidation scanner 做 durable 消费。只在 PG 后端提供
   * （EventStore 接口不强制其他实现）。envelope 携带行级 tenant_id /
   * session_sequence / global_sequence——PlatformEvent 自身不含这些字段。
   */
  async listGlobalPage(options: {
    afterGlobalSequence: number;
    types: ReadonlyArray<PlatformEvent['type']>;
    limit?: number;
  }): Promise<{
    events: Array<{
      globalSequence: number;
      sessionSequence: number;
      tenantId: string;
      sessionId: string;
      event: PlatformEvent;
    }>;
    hasMore: boolean;
  }> {
    const limit = options.limit && options.limit > 0 ? options.limit : 500;
    const result = await this.queryWithEventsShareLock<{
      global_sequence: string;
      session_sequence: string;
      tenant_id: string;
      session_id: string;
      event_json: PlatformEvent;
    }>(
      `SELECT global_sequence, session_sequence, tenant_id, session_id, event_json
       FROM ${this.eventsTable}
       WHERE global_sequence > $1
         AND event_type = ANY($2::text[])
       ORDER BY global_sequence ASC
       LIMIT $3`,
      [options.afterGlobalSequence, [...options.types], limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      events: rows.map((row) => ({
        globalSequence: Number(row.global_sequence),
        sessionSequence: Number(row.session_sequence),
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        event: normalizeEventJson(row.event_json),
      })),
      hasMore: result.rows.length > limit,
    };
  }

  /**
   * 会话内 (fromExclusive, toInclusive] 范围查询，返回行级 session_sequence
   * （2026-07-29 L2 记忆整合批次：digest 证据链需要精确 sequence，listPage 不
   * 暴露逐行序号）。
   */
  async listSessionRange(tenantId: string, sessionId: string, options: {
    fromExclusive: number;
    toInclusive: number;
    excludeTypes?: ReadonlyArray<PlatformEvent['type']>;
    limit?: number;
  }): Promise<Array<{ sessionSequence: number; event: PlatformEvent }>> {
    tenantId = requireTenantId(tenantId);
    const excludeTypes = [...new Set(options.excludeTypes ?? [])];
    const limit = options.limit && options.limit > 0 ? options.limit : 2_000;
    const result = await this.pool.query<{ session_sequence: string; event_json: PlatformEvent }>(
      `SELECT session_sequence, event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND tenant_id = $6
         AND session_sequence > $2
         AND session_sequence <= $3
         AND event_type <> ALL($4::text[])
       ORDER BY session_sequence ASC
       LIMIT $5`,
      [sessionId, options.fromExclusive, options.toInclusive, excludeTypes, limit, tenantId],
    );
    return result.rows.map((row) => ({
      sessionSequence: Number(row.session_sequence),
      event: normalizeEventJson(row.event_json),
    }));
  }

  async listByRun(tenantId: string, sessionId: string, runId: string): Promise<PlatformEvent[]> {
    tenantId = requireTenantId(tenantId);
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1 AND run_id = $2 AND tenant_id = $3
       ORDER BY session_sequence ASC`,
      [sessionId, runId, tenantId],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async listByToolCall(tenantId: string, sessionId: string, toolCallId: string): Promise<PlatformEvent[]> {
    tenantId = requireTenantId(tenantId);
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND tenant_id = $3
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
      [sessionId, toolCallId, tenantId],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async search(
    tenantId: string,
    sessionId: string,
    query: string,
    options: {
      limit?: number;
      runId?: string;
      type?: PlatformEvent['type'];
      excludeTypes?: PlatformEvent['type'][];
    } = {},
  ): Promise<PlatformEvent[]> {
    tenantId = requireTenantId(tenantId);
    const needle = query.trim();
    if (!needle) return [];
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 50);
    const excludeTypes = [...new Set(options.excludeTypes ?? [])];
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json
       FROM ${this.eventsTable}
       WHERE session_id = $1
         AND tenant_id = $7
         AND ($3::text IS NULL OR run_id = $3::text)
         AND ($4::text IS NULL OR event_type = $4::text)
         AND event_type <> ALL($6::text[])
         AND event_json::text ILIKE '%' || $2 || '%'
       ORDER BY session_sequence ASC
       LIMIT $5`,
      [sessionId, needle, options.runId ?? null, options.type ?? null, limit, excludeTypes, tenantId],
    );
    return result.rows.map((row) => normalizeEventJson(row.event_json));
  }

  async getById(tenantId: string, eventId: string): Promise<PlatformEvent | null> {
    tenantId = requireTenantId(tenantId);
    const result = await this.pool.query<{ event_json: PlatformEvent }>(
      `SELECT event_json FROM ${this.eventsTable} WHERE event_id = $1 AND tenant_id = $2 LIMIT 1`,
      [eventId, tenantId],
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
          `DELETE FROM ${this.cursorsTable} WHERE tenant_id = $1 AND session_id = ANY($2::text[])`,
          [tenantId, sessionIds],
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

  private async notifyAppended(client: PgPoolClient, events: Array<PlatformEvent & { sequence: number }>): Promise<void> {
    await client.query('SELECT pg_notify($1, $2)', [
      this.notifyChannel,
      encodePgEventNotifyPayload(events),
    ]);
  }

  /**
   * Subscribe to events appended by this or other server processes using PG
   * LISTEN/NOTIFY.
   *
   * NOTIFY 只作低延迟 wake。durable 投递始终扫描单调 global_sequence 水位；读取订阅
   * boundary 和每一页水位前，短事务都会在 events table 上取得 SHARE lock。该锁等待旧
   * writer INSERT 持有的 ROW EXCLUSIVE 事务结束，并阻止后续 writer 在 SELECT 完成前
   * 插入，因此滚动发布期间即使旧 writer 不拿 advisory lock，也不会越过未提交的低序号。
   *
   * callback 成功后才推进水位；LISTEN 重连与安全轮询使用同一锁定读取路径，所以丢失
   * NOTIFY 仍可恢复，且不依赖 payload exact hint。
   */
  async subscribeAppended(
    onEvent: (event: PlatformEvent) => void | Promise<void>,
    options: SubscribeAppendedOptions = {},
  ): Promise<() => Promise<void>> {
    const reconnectBaseDelayMs = options.reconnectDelayMs ?? 1_000;
    const reconnectMaxDelayMs = options.maxReconnectDelayMs ?? 15_000;
    const safetyPollIntervalMs = options.safetyPollIntervalMs ?? 10_000;
    const drainPageLimit =
      options.drainPageLimit && options.drainPageLimit > 0
        ? options.drainPageLimit
        : NOTIFY_RANGE_PAGE_LIMIT;

    let globalWatermark = 0n;
    let drainPromise: Promise<void> | null = null;
    let redo = false;
    let closed = false;
    let client: InstanceType<typeof Client> | null = null;
    let connectAttempt: Promise<void> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectDelay = reconnectBaseDelayMs;

    const readGlobalBoundary = async (): Promise<bigint> => {
      const result = await this.queryWithEventsShareLock<{ global_sequence: string }>(
        `SELECT COALESCE(MAX(global_sequence), 0)::text AS global_sequence
         FROM ${this.eventsTable}`,
      );
      return BigInt(result.rows[0]?.global_sequence ?? '0');
    };

    const drainGlobalWatermark = async (): Promise<void> => {
      while (!closed) {
        const result = await this.queryWithEventsShareLock<{
          global_sequence: string;
          event_json: PlatformEvent;
        }>(
          `SELECT global_sequence, event_json
           FROM ${this.eventsTable}
           WHERE global_sequence > $1
           ORDER BY global_sequence ASC
           LIMIT $2`,
          [globalWatermark.toString(), drainPageLimit],
        );
        if (result.rows.length === 0) break;
        for (const row of result.rows) {
          if (closed) return;
          try {
            await onEvent(normalizeEventJson(row.event_json));
          } catch (err) {
            this.options.logger?.warn?.(
              'PgEventStore subscriber onEvent failed',
              {
                error: err instanceof Error ? err.message : String(err),
              },
            );
            throw err;
          }
          // Advance only after callback success so a rejected callback remains retryable.
          const sequence = BigInt(row.global_sequence);
          if (sequence > globalWatermark) globalWatermark = sequence;
        }
        if (result.rows.length < drainPageLimit) break;
      }
    };

    // redo coalesces notifications, reconnects, and polls received while a drain is in flight.
    const drainGlobal = (): Promise<void> => {
      if (closed) return Promise.resolve();
      if (drainPromise) {
        redo = true;
        return drainPromise;
      }
      drainPromise = (async () => {
        let failed = false;
        try {
          do {
            redo = false;
            await drainGlobalWatermark();
          } while (redo && !closed);
        } catch (err) {
          failed = true;
          this.options.logger?.warn?.(
            'PgEventStore subscriber global drain failed',
            {
              globalWatermark: globalWatermark.toString(),
              error: err instanceof Error ? err.message : String(err),
            },
          );
        } finally {
          drainPromise = null;
          // A wake received while a failing callback was in flight must not be swallowed.
          // Consume that coalesced wake exactly once after releasing drainPromise. If the retry
          // also fails without another wake, it stops here rather than forming a hot loop.
          if (failed && redo && !closed) {
            redo = false;
            void drainGlobal();
          }
        }
      })();
      return drainPromise;
    };

    const handleNotification = (message: {
      channel: string;
      payload?: string | undefined;
    }): void => {
      if (message.channel !== this.notifyChannel) return;
      void drainGlobal();
    };

    const teardownClient = async (
      target: InstanceType<typeof Client> | null,
    ): Promise<void> => {
      if (!target) return;
      target.removeAllListeners('notification');
      target.removeAllListeners('error');
      target.removeAllListeners('end');
      await target.end().catch(() => undefined);
    };

    const connectOnce = async (): Promise<void> => {
      const next = new Client({
        connectionString: this.options.connectionString,
      });
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
      try {
        await next.connect();
        await next.query(`LISTEN ${this.notifyChannel}`);
      } catch (err) {
        await teardownClient(next);
        throw err;
      }
      // unsubscribe may close the subscription while connect/LISTEN is still in flight.
      // Such a client must never become active, even briefly.
      if (closed) {
        await teardownClient(next);
        return;
      }
      client = next;
      reconnectDelay = reconnectBaseDelayMs;
      // 初连补 subscription-boundary 到 LISTEN 生效之间的窗口；重连补断线窗口。
      void drainGlobal();
    };

    const startConnectAttempt = (): Promise<void> => {
      const attempt = connectOnce();
      connectAttempt = attempt;
      void attempt
        .finally(() => {
          if (connectAttempt === attempt) connectAttempt = null;
        })
        .catch(() => undefined);
      return attempt;
    };

    const scheduleReconnect = (): void => {
      if (closed || reconnectTimer) return;
      const failed = client;
      client = null;
      void teardownClient(failed);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closed) return;
        startConnectAttempt().catch((err) => {
          this.options.logger?.warn?.(
            'PgEventStore listener reconnect failed',
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
          reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxDelayMs);
          scheduleReconnect();
        });
      }, reconnectDelay);
      reconnectTimer.unref?.();
    };

    // 订阅点是该 durable 边界：边界前已有事件永不回放。先取边界、后 LISTEN 产生的
    // 窗口由首次 drain 补齐，因此连接建立过程也不漏新事件。
    globalWatermark = await readGlobalBoundary();

    // 初次连接遇到 PG 连接额度耗尽时进入指数退避；全局安全轮询仍可从订阅边界补拉。
    try {
      await startConnectAttempt();
    } catch (err) {
      if (!isPgConnectionCapacityError(err)) throw err;
      this.options.logger?.warn?.(
        'PgEventStore listener initial connect deferred: connection capacity exhausted',
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      scheduleReconnect();
    }

    if (safetyPollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        if (closed) return;
        void drainGlobal();
      }, safetyPollIntervalMs);
      pollTimer.unref?.();
    }

    return async () => {
      closed = true;
      const pendingConnect = connectAttempt;
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
        await active
          .query(`UNLISTEN ${this.notifyChannel}`)
          .catch(() => undefined);
        await teardownClient(active);
      }
      // A reconnect may currently be inside connect() or LISTEN. connectOnce observes closed after
      // LISTEN and tears the new client down instead of publishing it as active.
      await pendingConnect?.catch(() => undefined);
      // Do not return while a callback already admitted by drainGlobal is still running.
      // closed prevents any later row from entering the callback.
      await drainPromise;
    };
  }
}

function requireTenantId(tenantId: string): string {
  const normalized = tenantId.trim();
  if (!normalized) throw new Error('EventStore tenantId is required');
  return normalized;
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`非法 PG tablePrefix: ${value}`);
  }
  return value;
}

function normalizeEventJson(raw: PlatformEvent | string): PlatformEvent {
  return typeof raw === 'string' ? JSON.parse(raw) as PlatformEvent : raw;
}
