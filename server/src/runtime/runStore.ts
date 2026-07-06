import pg from 'pg';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../data/tenants/types.js';

const { Pool } = pg;

type PgPool = InstanceType<typeof Pool>;

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user'
  | 'waiting_hand'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

export interface RunRecord {
  runId: string;
  sessionId: string;
  userId?: string;
  tenantId?: string;
  status: RunStatus;
  statusReason?: string;
  model?: string;
  channel?: string;
  requestedAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  workerId?: string;
  leaseExpiresAt?: string;
  idempotencyKey?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  metadata: Record<string, unknown>;
  // ── Responses API session state（RFC v1 P0.4） ──
  /** 本 run 结束时最后一个 store=true 的 response.id（用于跨 run 接力 reasoning chain）。 */
  lastResponseId?: string;
  /** 上述 response 的服务端过期时间（72h TTL）。 */
  lastResponseExpireAt?: string;
  /** Responses API 返回的 response.model 实际别名值（用于审计/告警）。 */
  actualModelSeen?: string;
  /**
   * 产生 lastResponseId 时发给上游的 model 值（RunContext.model）。
   * 跨 run 接力的身份键：新 run 模型与它不一致时禁止接力——response id 是后端私有状态，
   * 拿 A 后端的 id 发给 B 后端必报 PreviousResponseNotFound（2026-07-02 切模型事故）。
   */
  lastResponseModel?: string;
  /** 本 run 内累计 input_tokens（嵌套接力会爆涨，监控用）。 */
  cumulativeInputTokens?: number;
}

export interface UpsertRunInput {
  runId: string;
  sessionId: string;
  userId?: string;
  /**
   * Tenant 归属（多组织改造 PR 3）。旧 PG 列回填 LEGACY_TENANT_ID；新写入缺省走平台根；PR 4
   * dispatch 层会从 ChannelContext.user.tenantId 显式透传。
   */
  tenantId?: string;
  model?: string;
  channel?: string;
  idempotencyKey?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Responses API session state patch（RFC v1 P0.4 / P1.6）
 * lastResponseExpireAt 传 ISO timestamp 或 epoch ms；cumulativeInputTokensDelta 是增量。
 */
export interface ResponseSessionStatePatch {
  lastResponseId?: string | null;
  lastResponseExpireAt?: string | null;
  actualModelSeen?: string | null;
  /** 产生 lastResponseId 的上游 model 值（接力身份键，见 RunRecord.lastResponseModel）。 */
  lastResponseModel?: string | null;
  cumulativeInputTokensDelta?: number;
}

/**
 * RFC v1 跨 run 接力查询结果。仅返回 reasoning chain 必需字段。
 */
export interface LatestResponseSessionState {
  runId: string;
  lastResponseId: string;
  lastResponseExpireAt?: string;
  actualModelSeen?: string;
  /** 产生 lastResponseId 的上游 model 值；缺失（存量数据）视为身份未知，调用方不得接力。 */
  lastResponseModel?: string;
  cumulativeInputTokens?: number;
}

export interface ActiveRunCounts {
  pending: number;
  running: number;
  waitingApproval: number;
  waitingUser: number;
  waitingHand: number;
  blocking: number;
  total: number;
}

export interface RunStore {
  init?(): Promise<void>;
  upsertPending(input: UpsertRunInput): Promise<RunRecord>;
  markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch?: Record<string, unknown>): Promise<RunRecord | null>;
  get(runId: string): Promise<RunRecord | null>;
  findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null>;
  getActiveBySession?(sessionId: string): Promise<RunRecord | null>;
  getActiveCounts?(): Promise<ActiveRunCounts>;
  listBySession?(sessionId: string, options?: { limit?: number; beforeUpdatedAt?: string }): Promise<RunRecord[]>;
  listRecoverable(now?: Date): Promise<RunRecord[]>;
  listStaleWaitingApproval?(cutoff: Date, limit?: number): Promise<RunRecord[]>;
  cancelStaleWaitingApproval?(runId: string, cutoff: Date, reason: string, metadataPatch?: Record<string, unknown>): Promise<RunRecord | null>;
  acquireLease?(runId: string, workerId: string, leaseMs: number, now?: Date): Promise<RunRecord | null>;
  renewLease?(runId: string, workerId: string, leaseMs: number, now?: Date): Promise<RunRecord | null>;
  releaseLease?(runId: string, workerId: string, finalStatus?: RunStatus, reason?: string): Promise<RunRecord | null>;
  /**
   * RFC v1 P0.4：增量更新 Responses API session state。
   * 用 COALESCE 让 null 显式清空，undefined 保留原值；delta 累加到 cumulative_input_tokens。
   */
  updateResponseSessionState?(runId: string, patch: ResponseSessionStatePatch): Promise<RunRecord | null>;
  /**
   * RFC v1 P0.4：按 sessionId 查最近有 last_response_id 的 run（用于新 run 启动时接力上一 run）。
   * 过滤掉已过期的（last_response_expire_at < now）。
   */
  findLatestResponseSessionStateBySession?(sessionId: string, now?: Date): Promise<LatestResponseSessionState | null>;
  /**
   * /compact 真实现（2026-07-03）：清空整个 session 的 Responses API 接力状态。
   * 压缩后若仍接力旧 response chain，远端保存的全量历史会绕过本地投影，压缩等于没做——
   * 且 findLatestResponseSessionStateBySession 只找「有 last_response_id 的 run」，
   * compact run 自身无 responseId 并不能自然阻断，必须显式按 session 清空。
   * 不更新 updated_at（避免把老 run 顶到观测排序顶部）。返回受影响行数。
   */
  clearResponseSessionStateBySession?(sessionId: string): Promise<number>;
}

export interface PgRunStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgRunStore implements RunStore {
  readonly pool: PgPool;
  readonly runsTable: string;
  private readonly ownsPool: boolean;

  constructor(options: PgRunStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgRunStore requires either pool or connectionString');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.runsTable = `${prefix}_runs`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    // 门禁加固（2026-06-22）：用 PG advisory lock 串行化并发 init。多进程（many-brains
    // 多实例同时启动 / chaos 多 worker 同时 init）会并发跑 `CREATE INDEX IF NOT EXISTS`，
    // 而 IF NOT EXISTS 对并发不原子——两端都判定"不存在"→ 都建 → 撞 pg_class 唯一约束
    // (23505)。锁绑定单条 dedicated 连接，覆盖全部 DDL 后释放；后到者阻塞到先到者建完，
    // 届时 IF NOT EXISTS 命中已存在→跳过。
    const lockKey = `${this.runsTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.runsTable} (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          user_id TEXT,
          status TEXT NOT NULL,
          status_reason TEXT,
          model TEXT,
          channel TEXT,
          requested_at TIMESTAMPTZ NOT NULL,
          started_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ,
          failed_at TIMESTAMPTZ,
          cancelled_at TIMESTAMPTZ,
          worker_id TEXT,
          lease_expires_at TIMESTAMPTZ,
          idempotency_key TEXT,
          execution_target TEXT,
          workspace_id TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'
        )
      `);
      // RFC v1 P0.4：Responses API session state 4 字段。
      // 用 ADD COLUMN IF NOT EXISTS 兼容存量 RDS（已落 134 sessions × 1014 events）。
      await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS last_response_id TEXT`);
      await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS last_response_expire_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS actual_model_seen TEXT`);
      // 2026-07-02：接力身份键（切模型后跨后端接力必炸，见 findLatestResponseSessionStateBySession 调用方）
      await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS last_response_model TEXT`);
      await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS cumulative_input_tokens BIGINT NOT NULL DEFAULT 0`);
      // PR 3：多组织改造 — 加 tenant_id 列，旧数据回填 LEGACY_TENANT_ID，新 run 由
      // dispatch 层（PR 4）显式传入；UpsertRunInput 已加可选 tenantId 字段。
      await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_tenant_idx ON ${this.runsTable} (tenant_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_status_idx ON ${this.runsTable} (status, updated_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_session_idx ON ${this.runsTable} (session_id, updated_at DESC)`);
      // RFC v1 P0.4：按 sessionId 找最近完成 run 的 last_response_id（跨 run 接力查询路径）
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_session_last_response_idx ON ${this.runsTable} (session_id, updated_at DESC) WHERE last_response_id IS NOT NULL`);
      await client.query(`DROP INDEX IF EXISTS ${this.runsTable}_active_idempotency_idx`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.runsTable}_active_idempotency_v2_idx ON ${this.runsTable} ((COALESCE(user_id, '__anonymous__')), idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_idempotency_lookup_idx ON ${this.runsTable} ((COALESCE(user_id, '__anonymous__')), idempotency_key, updated_at DESC) WHERE idempotency_key IS NOT NULL`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> { if (this.ownsPool) await this.pool.end(); }

  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      INSERT INTO ${this.runsTable}
        (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at, idempotency_key, execution_target, workspace_id, metadata)
      VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        status = CASE WHEN ${this.runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                      THEN 'pending' ELSE ${this.runsTable}.status END,
        status_reason = CASE WHEN ${this.runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                             THEN NULL ELSE ${this.runsTable}.status_reason END,
        worker_id = CASE WHEN ${this.runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                         THEN NULL ELSE ${this.runsTable}.worker_id END,
        lease_expires_at = CASE WHEN ${this.runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                                THEN NULL ELSE ${this.runsTable}.lease_expires_at END,
        metadata = ${this.runsTable}.metadata || EXCLUDED.metadata
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [input.runId, input.sessionId, input.userId ?? null, input.tenantId ?? null, input.model ?? null, input.channel ?? null, now, input.idempotencyKey ?? null, input.executionTarget ?? null, input.workspaceId ?? null, JSON.stringify(input.metadata ?? {})]);
    return normalizeRunRecord(result.rows[0]!.row_json);
  }

  async markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> {
    const now = new Date().toISOString();
    // 门禁加固（2026-06-22）：terminal 状态是 sink。已 completed/failed/cancelled/orphaned
    // 的 run 不能被重新写回活跃态（防 lease 抢占重叠期内旧 worker 经事件路径覆盖
    // 新 worker 状态 / 防终态被重激活）。terminal→相同 terminal 仍允许（幂等重写
    // reason/metadata）。用 CTE 保留"返回当前 run 记录"契约：守卫拦截时返回未变更的
    // 现有（terminal）记录，而不是 null，避免幂等调用方拿不到记录而误判。
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      WITH updated AS (
        UPDATE ${this.runsTable}
        SET status = $2,
            status_reason = $3,
            updated_at = $4,
            started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN $4 ELSE started_at END,
            completed_at = CASE WHEN $2 = 'completed' THEN $4 ELSE completed_at END,
            failed_at = CASE WHEN $2 = 'failed' THEN $4 ELSE failed_at END,
            cancelled_at = CASE WHEN $2 = 'cancelled' THEN $4 ELSE cancelled_at END,
            metadata = metadata || $5::jsonb
        WHERE run_id = $1
          AND (status NOT IN ('completed','failed','cancelled','orphaned') OR status = $2)
        RETURNING row_to_json(${this.runsTable}.*) AS row_json
      )
      SELECT row_json FROM updated
      UNION ALL
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE run_id = $1 AND NOT EXISTS (SELECT 1 FROM updated)
    `, [runId, status, reason ?? null, now, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async get(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`SELECT row_to_json(${this.runsTable}.*) AS row_json FROM ${this.runsTable} WHERE run_id = $1`, [runId]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE idempotency_key = $2
        AND COALESCE(user_id, '__anonymous__') = COALESCE($1, '__anonymous__')
      ORDER BY updated_at DESC
      LIMIT 1
    `, [userId ?? null, idempotencyKey]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async getActiveBySession(sessionId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE session_id = $1
        AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
      ORDER BY updated_at DESC
      LIMIT 1
    `, [sessionId]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async getActiveCounts(): Promise<ActiveRunCounts> {
    const result = await this.pool.query<{
      pending: string | number | null;
      running: string | number | null;
      waiting_approval: string | number | null;
      waiting_user: string | number | null;
      waiting_hand: string | number | null;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'running') AS running,
        COUNT(*) FILTER (WHERE status = 'waiting_approval') AS waiting_approval,
        COUNT(*) FILTER (WHERE status = 'waiting_user') AS waiting_user,
        COUNT(*) FILTER (WHERE status = 'waiting_hand') AS waiting_hand
      FROM ${this.runsTable}
      WHERE status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
    `);
    const row = result.rows[0];
    const pending = parseCount(row?.pending);
    const running = parseCount(row?.running);
    const waitingApproval = parseCount(row?.waiting_approval);
    const waitingUser = parseCount(row?.waiting_user);
    const waitingHand = parseCount(row?.waiting_hand);
    return {
      pending,
      running,
      waitingApproval,
      waitingUser,
      waitingHand,
      blocking: pending + running,
      total: pending + running + waitingApproval + waitingUser + waitingHand,
    };
  }

  async listBySession(sessionId: string, options: { limit?: number; beforeUpdatedAt?: string } = {}): Promise<RunRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE session_id = $1
        AND ($2::timestamptz IS NULL OR updated_at < $2::timestamptz)
      ORDER BY updated_at DESC
      LIMIT $3
    `, [sessionId, options.beforeUpdatedAt ?? null, limit]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }

  async listSessionIdsByTenant(tenantId: string): Promise<string[]> {
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM ${this.runsTable} WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows.map(row => row.session_id);
  }

  async deleteByTenant(tenantId: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM ${this.runsTable} WHERE tenant_id = $1`, [tenantId]);
    return result.rowCount ?? 0;
  }

  async listRecoverable(now = new Date()): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE status = 'pending'
         OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < $1))
      ORDER BY updated_at ASC
    `, [now.toISOString()]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }

  async listStaleWaitingApproval(cutoff: Date, limit = 50): Promise<RunRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE status = 'waiting_approval'
        AND updated_at < $1::timestamptz
      ORDER BY updated_at ASC
      LIMIT $2
    `, [cutoff.toISOString(), boundedLimit]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }

  async cancelStaleWaitingApproval(
    runId: string,
    cutoff: Date,
    reason: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const now = new Date().toISOString();
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET status = 'cancelled',
          status_reason = $3,
          updated_at = $4,
          cancelled_at = COALESCE(cancelled_at, $4),
          worker_id = NULL,
          lease_expires_at = NULL,
          metadata = metadata || $5::jsonb
      WHERE run_id = $1
        AND status = 'waiting_approval'
        AND updated_at < $2::timestamptz
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, cutoff.toISOString(), reason, now, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async acquireLease(runId: string, workerId: string, leaseMs: number, now = new Date()): Promise<RunRecord | null> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET status = 'running',
          worker_id = $2,
          lease_expires_at = $3,
          started_at = COALESCE(started_at, $4),
          updated_at = $4
      WHERE run_id = $1
        AND (
          status = 'pending'
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < $4))
        )
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, workerId, leaseExpiresAt, now.toISOString()]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async renewLease(runId: string, workerId: string, leaseMs: number, now = new Date()): Promise<RunRecord | null> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET lease_expires_at = $3,
          updated_at = $4
      WHERE run_id = $1
        AND worker_id = $2
        AND status = 'running'
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, workerId, leaseExpiresAt, now.toISOString()]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  /**
   * RFC v1 P0.4：增量更新 Responses API session state。
   *
   * - lastResponseId/lastResponseExpireAt/actualModelSeen：传 undefined 保留原值，传 null 清空，传字符串覆盖
   * - cumulativeInputTokensDelta：累加到 cumulative_input_tokens（绝不允许直接覆盖避免并发丢失）
   */
  async updateResponseSessionState(runId: string, patch: ResponseSessionStatePatch): Promise<RunRecord | null> {
    const sets: string[] = ['updated_at = $2'];
    const params: unknown[] = [runId, new Date().toISOString()];
    let nextIdx = 3;
    if (patch.lastResponseId !== undefined) {
      sets.push(`last_response_id = $${nextIdx}`);
      params.push(patch.lastResponseId);
      nextIdx++;
    }
    if (patch.lastResponseExpireAt !== undefined) {
      sets.push(`last_response_expire_at = $${nextIdx}`);
      params.push(patch.lastResponseExpireAt);
      nextIdx++;
    }
    if (patch.actualModelSeen !== undefined) {
      sets.push(`actual_model_seen = $${nextIdx}`);
      params.push(patch.actualModelSeen);
      nextIdx++;
    }
    if (patch.lastResponseModel !== undefined) {
      sets.push(`last_response_model = $${nextIdx}`);
      params.push(patch.lastResponseModel);
      nextIdx++;
    }
    if (patch.cumulativeInputTokensDelta !== undefined && patch.cumulativeInputTokensDelta !== 0) {
      sets.push(`cumulative_input_tokens = cumulative_input_tokens + $${nextIdx}`);
      params.push(patch.cumulativeInputTokensDelta);
      nextIdx++;
    }
    // 只有 updated_at 没东西改，跳过
    if (sets.length === 1) return this.get(runId);
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET ${sets.join(', ')}
      WHERE run_id = $1
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, params);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  /**
   * RFC v1 P0.4：按 sessionId 查最近一条有 last_response_id 且未过期的 run。
   */
  async findLatestResponseSessionStateBySession(
    sessionId: string,
    now: Date = new Date(),
  ): Promise<LatestResponseSessionState | null> {
    const result = await this.pool.query<{
      run_id: string;
      last_response_id: string;
      last_response_expire_at: string | null;
      actual_model_seen: string | null;
      last_response_model: string | null;
      cumulative_input_tokens: string | number | null;
    }>(`
      SELECT run_id, last_response_id, last_response_expire_at, actual_model_seen, last_response_model, cumulative_input_tokens
      FROM ${this.runsTable}
      WHERE session_id = $1
        AND last_response_id IS NOT NULL
        AND (last_response_expire_at IS NULL OR last_response_expire_at > $2::timestamptz)
      ORDER BY updated_at DESC
      LIMIT 1
    `, [sessionId, now.toISOString()]);
    const row = result.rows[0];
    if (!row) return null;
    const cumulative = typeof row.cumulative_input_tokens === 'string'
      ? Number.parseInt(row.cumulative_input_tokens, 10) || 0
      : (row.cumulative_input_tokens ?? 0);
    return {
      runId: row.run_id,
      lastResponseId: row.last_response_id,
      ...(row.last_response_expire_at
        ? { lastResponseExpireAt: new Date(row.last_response_expire_at).toISOString() }
        : {}),
      ...(row.actual_model_seen ? { actualModelSeen: row.actual_model_seen } : {}),
      ...(row.last_response_model ? { lastResponseModel: row.last_response_model } : {}),
      ...(cumulative ? { cumulativeInputTokens: cumulative } : {}),
    };
  }

  async clearResponseSessionStateBySession(sessionId: string): Promise<number> {
    const result = await this.pool.query(`
      UPDATE ${this.runsTable}
      SET last_response_id = NULL
      WHERE session_id = $1 AND last_response_id IS NOT NULL
    `, [sessionId]);
    return result.rowCount ?? 0;
  }

  async releaseLease(runId: string, workerId: string, finalStatus?: RunStatus, reason?: string): Promise<RunRecord | null> {
    const now = new Date().toISOString();
    // 门禁加固（2026-06-22）：terminal 状态是 sink。lease 持有者 release 时仍无条件
    // 清 worker_id / lease_expires_at（保证 lease 被正确释放），但若 run 已是 terminal
    // 则 status / status_reason / 终态时间戳保持不变，不被 finalStatus 降级或改写。
    // CASE 里的 status IN (...) 引用的是 UPDATE 前的旧值（PG 语义）。
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET status = CASE WHEN status IN ('completed','failed','cancelled','orphaned')
                        THEN status ELSE COALESCE($3, status) END,
          status_reason = CASE WHEN status IN ('completed','failed','cancelled','orphaned')
                        THEN status_reason ELSE COALESCE($4, status_reason) END,
          worker_id = NULL,
          lease_expires_at = NULL,
          updated_at = $5,
          completed_at = CASE WHEN $3 = 'completed' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE completed_at END,
          failed_at = CASE WHEN $3 = 'failed' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE failed_at END,
          cancelled_at = CASE WHEN $3 = 'cancelled' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE cancelled_at END
      WHERE run_id = $1
        AND worker_id = $2
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, workerId, finalStatus ?? null, reason ?? null, now]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}

function parseCount(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

function normalizeRunRecord(raw: any): RunRecord {
  return {
    runId: raw.run_id ?? raw.runId,
    sessionId: raw.session_id ?? raw.sessionId,
    userId: raw.user_id ?? raw.userId ?? undefined,
    tenantId: raw.tenant_id ?? raw.tenantId ?? undefined,
    status: raw.status,
    statusReason: raw.status_reason ?? raw.statusReason ?? undefined,
    model: raw.model ?? undefined,
    channel: raw.channel ?? undefined,
    requestedAt: new Date(raw.requested_at ?? raw.requestedAt).toISOString(),
    startedAt: raw.started_at ? new Date(raw.started_at).toISOString() : raw.startedAt,
    updatedAt: new Date(raw.updated_at ?? raw.updatedAt).toISOString(),
    completedAt: raw.completed_at ? new Date(raw.completed_at).toISOString() : raw.completedAt,
    failedAt: raw.failed_at ? new Date(raw.failed_at).toISOString() : raw.failedAt,
    cancelledAt: raw.cancelled_at ? new Date(raw.cancelled_at).toISOString() : raw.cancelledAt,
    workerId: raw.worker_id ?? raw.workerId ?? undefined,
    leaseExpiresAt: raw.lease_expires_at ? new Date(raw.lease_expires_at).toISOString() : raw.leaseExpiresAt,
    idempotencyKey: raw.idempotency_key ?? raw.idempotencyKey ?? undefined,
    executionTarget: raw.execution_target ?? raw.executionTarget ?? undefined,
    workspaceId: raw.workspace_id ?? raw.workspaceId ?? undefined,
    metadata: raw.metadata ?? {},
    lastResponseId: raw.last_response_id ?? raw.lastResponseId ?? undefined,
    lastResponseExpireAt: raw.last_response_expire_at
      ? new Date(raw.last_response_expire_at).toISOString()
      : raw.lastResponseExpireAt,
    actualModelSeen: raw.actual_model_seen ?? raw.actualModelSeen ?? undefined,
    lastResponseModel: raw.last_response_model ?? raw.lastResponseModel ?? undefined,
    cumulativeInputTokens: (() => {
      const v = raw.cumulative_input_tokens ?? raw.cumulativeInputTokens;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') return Number.parseInt(v, 10) || 0;
      return undefined;
    })(),
  };
}
