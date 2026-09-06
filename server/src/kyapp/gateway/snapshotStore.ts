/**
 * WP3：会话工具快照的持久化（规范 §6.1「会话首个 run 创建并写入会话记录」）。
 *
 * 为什么必须落库而不是进程内（总控 2026-09-06 拍板，偏差 3-A-05）：
 * 生产是多进程拓扑（Web/API blue|green + 独立 runtime-worker@blue|green）。
 * 审批恢复走 Web 进程、后台任务走 worker 进程，进程内快照必然导致恢复路径
 * 工具面漂移、`prompt_cache_key` 失配。
 *
 * 并发语义 = **首个写入者获胜**：`ON CONFLICT DO UPDATE ... WHERE snapshot_key 变了`。
 * 两个进程同时为同一会话建快照时，后到者的 UPDATE 不满足 WHERE、不落库，
 * 随后回读到先到者那一份 —— 两个进程收敛到逐字节相同的工具面。
 */
import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
import type { AppCapabilityEntry } from './snapshot.js';

/** 落库形态；`entries` 直接存 `AppCapabilityEntry[]`（manifest 已由发布门禁校验过）。 */
export interface PersistedAppToolSnapshot {
  sessionId: string;
  tenantId: string;
  userId: string;
  key: string;
  entries: AppCapabilityEntry[];
  degraded: boolean;
  createdAt: number;
}

export interface AppToolSnapshotStore {
  load(sessionId: string): Promise<PersistedAppToolSnapshot | null>;
  /** 写入并返回**最终生效**的那一份（可能是别的进程先写进去的）。 */
  save(snapshot: PersistedAppToolSnapshot): Promise<PersistedAppToolSnapshot>;
  /** `installation.*` 事件：删掉所有含该安装实例的快照。返回删除行数。 */
  deleteByInstallation(installationId: string): Promise<number>;
  deleteBySession(sessionId: string): Promise<number>;
}

export interface PgAppToolSnapshotStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

type Row = Record<string, unknown>;

function rowToSnapshot(row: Row): PersistedAppToolSnapshot {
  const createdAt = row.created_at;
  return {
    sessionId: String(row.session_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    key: String(row.snapshot_key),
    entries: Array.isArray(row.entries) ? (row.entries as AppCapabilityEntry[]) : [],
    degraded: row.degraded === true,
    createdAt: createdAt instanceof Date ? createdAt.getTime() : Number(createdAt) || 0,
  };
}

export class PgAppToolSnapshotStore implements AppToolSnapshotStore {
  readonly table: string;

  private readonly tablePrefix?: string;

  constructor(private readonly options: PgAppToolSnapshotStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.table = `${prefix}_ky_app_session_tool_snapshots`;
  }

  /** 与其余 kyapp store 共用同一套 governance 迁移 runner（幂等）。 */
  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async load(sessionId: string): Promise<PersistedAppToolSnapshot | null> {
    const result = await this.options.pool.query(
      `SELECT session_id, tenant_id, user_id, snapshot_key, entries, degraded, created_at
       FROM ${this.table} WHERE session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row ? rowToSnapshot(row as Row) : null;
  }

  async save(snapshot: PersistedAppToolSnapshot): Promise<PersistedAppToolSnapshot> {
    const installationIds = [
      ...new Set(snapshot.entries.map((entry) => entry.installationId)),
    ].sort();
    const result = await this.options.pool.query(
      `INSERT INTO ${this.table}
         (session_id,tenant_id,user_id,snapshot_key,installation_ids,entries,degraded)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
       ON CONFLICT (session_id) DO UPDATE SET
         snapshot_key = EXCLUDED.snapshot_key,
         installation_ids = EXCLUDED.installation_ids,
         entries = EXCLUDED.entries,
         degraded = EXCLUDED.degraded,
         updated_at = NOW()
       WHERE ${this.table}.snapshot_key <> EXCLUDED.snapshot_key
       RETURNING session_id, tenant_id, user_id, snapshot_key, entries, degraded, created_at`,
      [
        snapshot.sessionId,
        snapshot.tenantId,
        snapshot.userId,
        snapshot.key,
        JSON.stringify(installationIds),
        JSON.stringify(snapshot.entries),
        snapshot.degraded,
      ],
    );
    const row = result.rows[0];
    // 没有返回行 = ON CONFLICT 的 WHERE 不成立 = 已有同 key 的快照（别的进程先写了）。
    if (row) return rowToSnapshot(row as Row);
    return (await this.load(snapshot.sessionId)) ?? snapshot;
  }

  async deleteByInstallation(installationId: string): Promise<number> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.table} WHERE installation_ids @> $1::jsonb`,
      [JSON.stringify([installationId])],
    );
    return result.rowCount ?? 0;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.table} WHERE session_id = $1`,
      [sessionId],
    );
    return result.rowCount ?? 0;
  }
}
