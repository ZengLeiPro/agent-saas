/**
 * WP2b 目录变更日志（规范 §3.6）：全局单调 seq 的追加与读取，外加 30 天保留清理。
 *
 * **本文件最重要的一件事是读侧的 `LOCK TABLE ... IN SHARE MODE`**，口径照抄
 * `server/src/runtime/pgEventStore.ts` 的 `queryWithEventsShareLock`（该文件 100-113 行）：
 *
 *   BIGSERIAL 的序号在 INSERT 语句执行时就分配了，但事务的**提交顺序**与序号顺序无关。
 *   写者 A 先拿到 seq=7、写者 B 后拿到 seq=8，B 先提交而 A 还没提交时，
 *   一个裸 `WHERE seq > 6` 的读者会读到 [8] 并把游标推到 8；等 A 提交后，
 *   seq=7 永远落在游标后面——**消费端按 seq 续流会静默丢事件**。
 *   SHARE 锁与 INSERT 持有的 ROW EXCLUSIVE 冲突：读者要么等在建的 INSERT 落定，
 *   要么让后来的 INSERT 排在自己后面，于是读到的序号区间一定是连续无洞的。
 *
 * 追加侧刻意做成「可并入调用方事务」：投影器必须在同一个事务里同时写变更事件与投影态，
 * 否则崩在中间会出现「事件已发但投影态没更新」的重复事件，或者反过来的丢事件。
 */
import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
import type {
  DirectoryChangeRecord,
  DirectoryChangeType,
  DirectoryGroup,
  DirectorySourceId,
  DirectoryUser,
} from './types.js';

/** §3.6：变更流保留 30 天，`after` 早于下界即 410 `cursor_expired`。 */
export const DIRECTORY_CHANGE_RETENTION_DAYS = 30;

/** §3.6：`changes` 单批上限，与消费端 `DIRECTORY_CHANGES_LIMIT` 对称。 */
export const DIRECTORY_CHANGES_MAX_LIMIT = 500;

export interface AppendDirectoryChangeInput {
  tenantId: string;
  source: DirectorySourceId;
  type: DirectoryChangeType;
  entityId: string;
  /** upsert 事件装附录 L 实体；remove 事件不装载荷（实体 id 已在 `entityId`）。 */
  payload?: DirectoryUser | DirectoryGroup;
  eventId?: string;
  occurredAt?: Date;
}

export interface ListDirectoryChangesInput {
  tenantId: string;
  /** 消费端游标；返回 `seq > afterSeq` 的事件。 */
  afterSeq: number;
  limit?: number;
}

export interface ListDirectoryChangesResult {
  records: DirectoryChangeRecord[];
  /** 本批之后的游标；无事件时保持 `afterSeq` 不动（附录 L `nextSeq`）。 */
  nextSeq: number;
  hasMore: boolean;
}

type Row = Record<string, unknown>;

/** 与 `pg.Pool` / `pg.PoolClient` 共同的最小面：只要能 `query` 就能用。 */
export interface DirectoryQueryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

function rowToRecord(row: Row): DirectoryChangeRecord {
  return {
    seq: Number(row.seq),
    eventId: String(row.event_id),
    tenantId: String(row.tenant_id),
    source: String(row.source) as DirectorySourceId,
    type: String(row.type) as DirectoryChangeType,
    entityId: String(row.entity_id),
    payload: (row.payload ?? {}) as DirectoryChangeRecord['payload'],
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(String(row.occurred_at)).toISOString(),
  };
}

export interface PgKyAppDirectoryChangeLogOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

export class PgKyAppDirectoryChangeLog {
  readonly table: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgKyAppDirectoryChangeLogOptions) {
    this.tablePrefix = options.tablePrefix;
    this.table = `${governanceTablePrefix(options.tablePrefix)}_ky_app_directory_change_log`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  /**
   * 在**调用方给定的连接**上追加一批事件（投影器传正在事务中的 client）。
   * `eventId` 唯一冲突即幂等跳过：同一批投影被重跑时不会产生重复事件。
   */
  async appendWithin(
    client: DirectoryQueryable,
    inputs: readonly AppendDirectoryChangeInput[],
  ): Promise<DirectoryChangeRecord[]> {
    const appended: DirectoryChangeRecord[] = [];
    for (const input of inputs) {
      const result = await client.query(
        `INSERT INTO ${this.table}
           (event_id,tenant_id,source,type,entity_id,payload,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,COALESCE($7::timestamptz,NOW()))
         ON CONFLICT (event_id) DO NOTHING
         RETURNING *`,
        [
          input.eventId ?? randomUUID(),
          input.tenantId,
          input.source,
          input.type,
          input.entityId,
          JSON.stringify(input.payload ?? {}),
          input.occurredAt ?? null,
        ],
      );
      if (result.rows[0]) appended.push(rowToRecord(result.rows[0] as Row));
    }
    return appended;
  }

  /** 自带事务的追加，供测试与非投影路径使用。 */
  async append(inputs: readonly AppendDirectoryChangeInput[]): Promise<DirectoryChangeRecord[]> {
    if (inputs.length === 0) return [];
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const appended = await this.appendWithin(client, inputs);
      await client.query('COMMIT');
      return appended;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 读侧的唯一入口：先 `LOCK TABLE ... IN SHARE MODE` 再查，保证游标不跳号。
   * 见文件头注释——去掉这把锁就会丢事件，这是本 WP 最容易翻车的点。
   */
  private async queryWithShareLock<R extends pg.QueryResultRow>(
    text: string,
    values: unknown[],
  ): Promise<pg.QueryResult<R>> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      // SHARE 与 INSERT 的 ROW EXCLUSIVE 冲突；PostgreSQL 的锁队列还会把后到的 INSERT
      // 排在本读者之后，因此本次 SELECT 的快照里不会缺号。
      await client.query(`LOCK TABLE ${this.table} IN SHARE MODE`);
      const result = await client.query<R>(text, values);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 按 seq 续流。多取一条用来判 `hasMore`，不额外发 COUNT。 */
  async listAfter(input: ListDirectoryChangesInput): Promise<ListDirectoryChangesResult> {
    const limit = Math.min(
      Math.max(input.limit ?? DIRECTORY_CHANGES_MAX_LIMIT, 1),
      DIRECTORY_CHANGES_MAX_LIMIT,
    );
    const result = await this.queryWithShareLock(
      `SELECT * FROM ${this.table}
       WHERE tenant_id=$1 AND seq > $2
       ORDER BY seq
       LIMIT $3`,
      [input.tenantId, input.afterSeq, limit + 1],
    );
    const rows = result.rows.map((row) => rowToRecord(row as Row));
    const hasMore = rows.length > limit;
    const records = hasMore ? rows.slice(0, limit) : rows;
    const last = records[records.length - 1];
    return {
      records,
      nextSeq: last ? last.seq : input.afterSeq,
      hasMore,
    };
  }

  /** 当前水位（该组织已提交的最大 seq）；同样走 SHARE 锁，避免读到「未来的」水位。 */
  async latestSeq(tenantId: string): Promise<number> {
    const result = await this.queryWithShareLock<{ seq: string | null }>(
      `SELECT MAX(seq) AS seq FROM ${this.table} WHERE tenant_id=$1`,
      [tenantId],
    );
    const value = result.rows[0]?.seq;
    return value === null || value === undefined ? 0 : Number(value);
  }

  /**
   * 保留期下界：该组织仍在库里的最小 seq 减一。
   * 消费端的 `after` 小于它就说明中间已经被清理掉，Phase B 据此回 410 `cursor_expired`。
   */
  async retentionFloorSeq(tenantId: string): Promise<number> {
    const result = await this.queryWithShareLock<{ seq: string | null }>(
      `SELECT MIN(seq) AS seq FROM ${this.table} WHERE tenant_id=$1`,
      [tenantId],
    );
    const value = result.rows[0]?.seq;
    return value === null || value === undefined ? 0 : Number(value) - 1;
  }

  /**
   * 30 天保留清理（§3.6）。只按 `occurred_at` 删过期行，不动未过期行，也不重排 seq——
   * seq 序列本身继续单调递增，被清理掉的号段就是消费端必须重拉快照的信号。
   */
  async purgeExpired(input?: { now?: Date; retentionDays?: number }): Promise<number> {
    const retentionDays = input?.retentionDays ?? DIRECTORY_CHANGE_RETENTION_DAYS;
    const now = input?.now ?? new Date();
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.options.pool.query(
      `DELETE FROM ${this.table} WHERE occurred_at < $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }
}
