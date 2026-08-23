/**
 * L2 记忆整合的 PG 持久层（2026-07-29 记忆写入职责剥离批次）。
 *
 * 五张表（随 store init 建，风格与 PgEventStore.init 一致：advisory lock 串行化）：
 *   - <prefix>_memory_consolidation_consumers：全局扫描游标（正确性来源）。
 *   - <prefix>_memory_consolidation_skips：永久缺失 projection 等 poison event 的隔离台账。
 *   - <prefix>_memory_consolidation_state：会话待办状态机（PK = tenant_id, session_id）。
 *   - <prefix>_memory_consolidation_runs：每个 (session, from, to] 范围的幂等 ledger。
 *   - <prefix>_memory_tombstones：「忘记」逻辑删除记录（L1 写入、L2/L3 提交前必查）。
 *
 * 并发不变量：
 *   - boundary event 以 last_boundary_global_sequence fencing，迟到的旧 scanner 不能覆盖新状态；
 *   - poison event 隔离与 consumer cursor 在同一 PG 事务提交；
 *   - claimDue 用 FOR UPDATE SKIP LOCKED，蓝绿双 worker 不会抢到同一 state；
 *   - runs.idempotency_key UNIQUE：同范围只有一份 ledger；
 *   - processed 只在 markApplied（applied/noop）里推进，且带 CHECK 约束；
 *   - per-user 文件写锁用 PG advisory lock（acquireCommitLock/releaseCommitLock），
 *     L1/L2/L3 共用；L2/L3 直接写 Markdown 时覆盖整个隐藏 Run。
 */

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import type {
  ConsolidationRunRecord,
  ConsolidationRunStatus,
  ConsolidationState,
  MemoryTombstone,
  TombstoneScope,
} from './types.js';

export interface PgConsolidationStoreOptions {
  connectionString: string;
  tablePrefix?: string;
  logger?: { info?: (msg: string, meta?: unknown) => void; warn?: (msg: string, meta?: unknown) => void };
}

interface StateRow {
  tenant_id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  processed_session_sequence: string;
  target_session_sequence: string;
  first_pending_at: Date | null;
  due_at: Date | null;
  last_activity_at: Date | null;
  active_run_ids: unknown;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  prompt_version: number | null;
}

function mapState(row: StateRow): ConsolidationState {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    processedSessionSequence: Number(row.processed_session_sequence),
    targetSessionSequence: Number(row.target_session_sequence),
    firstPendingAt: row.first_pending_at?.toISOString() ?? null,
    dueAt: row.due_at?.toISOString() ?? null,
    lastActivityAt: row.last_activity_at?.toISOString() ?? null,
    activeRunIds: Array.isArray(row.active_run_ids) ? (row.active_run_ids as string[]) : [],
    status: row.status as ConsolidationState['status'],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    promptVersion: row.prompt_version,
  };
}

export class PgMemoryConsolidationStore {
  private readonly pool: Pool;
  private readonly prefix: string;

  constructor(private readonly options: PgConsolidationStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, max: 4 });
    this.pool.on('error', (err) => {
      options.logger?.warn?.('PgMemoryConsolidationStore idle client error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.prefix = options.tablePrefix ?? 'agent_runtime';
  }

  private get consumersTable(): string { return `${this.prefix}_memory_consolidation_consumers`; }
  private get skipsTable(): string { return `${this.prefix}_memory_consolidation_skips`; }
  private get stateTable(): string { return `${this.prefix}_memory_consolidation_state`; }
  private get runsTable(): string { return `${this.prefix}_memory_consolidation_runs`; }
  private get tombstonesTable(): string { return `${this.prefix}_memory_tombstones`; }

  async init(): Promise<void> {
    const lockKey = `${this.stateTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.consumersTable} (
          consumer_name TEXT PRIMARY KEY,
          last_global_sequence BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.skipsTable} (
          consumer_name TEXT NOT NULL,
          global_sequence BIGINT NOT NULL,
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_timestamp TIMESTAMPTZ,
          reason TEXT NOT NULL,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          skipped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (consumer_name, global_sequence)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.skipsTable}_tenant_idx
        ON ${this.skipsTable} (tenant_id, skipped_at DESC)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.stateTable} (
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          processed_session_sequence BIGINT NOT NULL DEFAULT 0,
          target_session_sequence BIGINT NOT NULL DEFAULT 0,
          first_pending_at TIMESTAMPTZ,
          due_at TIMESTAMPTZ,
          last_activity_at TIMESTAMPTZ,
          active_run_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          status TEXT NOT NULL DEFAULT 'idle',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TIMESTAMPTZ,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          prompt_version INTEGER,
          last_boundary_global_sequence BIGINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (tenant_id, session_id),
          CHECK (processed_session_sequence <= target_session_sequence)
        )
      `);
      await client.query(`
        ALTER TABLE ${this.stateTable}
        ADD COLUMN IF NOT EXISTS last_boundary_global_sequence BIGINT NOT NULL DEFAULT 0
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.stateTable}_due_idx
        ON ${this.stateTable} (status, due_at, next_attempt_at)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.stateTable}_user_idx
        ON ${this.stateTable} (tenant_id, user_id, updated_at)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.runsTable} (
          id UUID PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          from_session_sequence BIGINT NOT NULL,
          to_session_sequence BIGINT NOT NULL,
          status TEXT NOT NULL,
          model_requested TEXT,
          model_actual TEXT,
          prompt_version INTEGER NOT NULL,
          usage_json JSONB,
          retry_count INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          started_at TIMESTAMPTZ,
          applied_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.runsTable}_session_idx
        ON ${this.runsTable} (tenant_id, session_id, created_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.runsTable}_user_day_idx
        ON ${this.runsTable} (tenant_id, user_id, created_at DESC)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tombstonesTable} (
          id UUID PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          memory_key TEXT,
          normalized_fingerprint TEXT,
          subject_text TEXT,
          scope TEXT NOT NULL,
          source TEXT NOT NULL,
          reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          revoked_at TIMESTAMPTZ
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.tombstonesTable}_user_idx
        ON ${this.tombstonesTable} (tenant_id, user_id, created_at DESC)
      `);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── 全局扫描游标 ─────────────────────────────────────────────

  async getConsumerCursor(consumerName: string): Promise<number> {
    const res = await this.pool.query<{ last_global_sequence: string }>(
      `SELECT last_global_sequence FROM ${this.consumersTable} WHERE consumer_name = $1`,
      [consumerName],
    );
    return res.rows[0] ? Number(res.rows[0].last_global_sequence) : 0;
  }

  async advanceConsumerCursor(consumerName: string, toGlobalSequence: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.consumersTable} (consumer_name, last_global_sequence, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (consumer_name) DO UPDATE
       SET last_global_sequence = GREATEST(${this.consumersTable}.last_global_sequence, EXCLUDED.last_global_sequence),
           updated_at = NOW()`,
      [consumerName, toGlobalSequence],
    );
  }

  /**
   * poison event 隔离与 consumer 推进必须在同一事务：不能留下「台账已写、
   * cursor 未进」的崩溃缝。重复执行按 consumer + sequence 幂等。
   */
  async quarantineEnvelopeAndAdvanceCursor(input: {
    consumerName: string;
    globalSequence: number;
    tenantId: string;
    sessionId: string;
    eventType: string;
    eventTimestamp?: string;
    reason: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ${this.skipsTable}
           (consumer_name, global_sequence, tenant_id, session_id, event_type, event_timestamp, reason)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)
         ON CONFLICT (consumer_name, global_sequence) DO UPDATE SET
           skipped_at = NOW(),
           reason = EXCLUDED.reason`,
        [
          input.consumerName,
          input.globalSequence,
          input.tenantId,
          input.sessionId,
          input.eventType,
          input.eventTimestamp ?? null,
          input.reason,
        ],
      );
      await client.query(
        `INSERT INTO ${this.consumersTable} (consumer_name, last_global_sequence, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (consumer_name) DO UPDATE
         SET last_global_sequence = GREATEST(${this.consumersTable}.last_global_sequence, EXCLUDED.last_global_sequence),
             updated_at = NOW()`,
        [input.consumerName, input.globalSequence],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── 会话状态机 ───────────────────────────────────────────────

  async applyRunStarted(input: {
    tenantId: string; userId: string; workspaceId: string; sessionId: string;
    runId: string; at: string; globalSequence: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.stateTable}
         (tenant_id, user_id, workspace_id, session_id, active_run_ids, last_activity_at,
          status, last_boundary_global_sequence)
       VALUES ($1, $2, $3, $4, jsonb_build_array($5::text), $6, 'idle', $7)
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET
         active_run_ids = (
           SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
           FROM jsonb_array_elements_text(${this.stateTable}.active_run_ids || jsonb_build_array($5::text)) AS value
         ),
         last_activity_at = GREATEST(COALESCE(${this.stateTable}.last_activity_at, $6), $6),
         due_at = NULL,
         last_boundary_global_sequence = $7,
         updated_at = NOW()
       WHERE ${this.stateTable}.last_boundary_global_sequence < $7`,
      [
        input.tenantId, input.userId, input.workspaceId, input.sessionId,
        input.runId, input.at, input.globalSequence,
      ],
    );
  }

  async applyRunFinished(input: {
    tenantId: string; userId: string; workspaceId: string; sessionId: string;
    runId: string; sessionSequence: number; at: string; globalSequence: number;
    /** eligible=false（如 error run）时只清 active、不提高 target、不设 due */
    eligible: boolean;
    debounceMinutes: number;
  }): Promise<void> {
    if (input.eligible) {
      await this.pool.query(
        `INSERT INTO ${this.stateTable}
           (tenant_id, user_id, workspace_id, session_id, target_session_sequence,
            first_pending_at, due_at, last_activity_at, status, last_boundary_global_sequence)
         VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + make_interval(mins => $7), $6, 'pending', $9)
         ON CONFLICT (tenant_id, session_id) DO UPDATE SET
           active_run_ids = (
             SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
             FROM jsonb_array_elements_text(${this.stateTable}.active_run_ids) AS value
             WHERE value <> $8
           ),
           target_session_sequence = GREATEST(${this.stateTable}.target_session_sequence, $5),
           first_pending_at = COALESCE(${this.stateTable}.first_pending_at, $6),
           due_at = $6::timestamptz + make_interval(mins => $7),
           last_activity_at = GREATEST(COALESCE(${this.stateTable}.last_activity_at, $6), $6),
           status = 'pending', attempts = 0, next_attempt_at = NULL,
           last_boundary_global_sequence = $9,
           updated_at = NOW()
         WHERE ${this.stateTable}.last_boundary_global_sequence < $9`,
        [
          input.tenantId, input.userId, input.workspaceId, input.sessionId,
          input.sessionSequence, input.at, input.debounceMinutes, input.runId, input.globalSequence,
        ],
      );
    } else {
      // 即使对应 run_started 尚未落库，也先建立 sequence fence，防止旧 started
      // 在蓝绿交接时迟到并把已结束会话重新置为 active。
      await this.pool.query(
        `INSERT INTO ${this.stateTable}
           (tenant_id, user_id, workspace_id, session_id, active_run_ids,
            last_activity_at, status, last_boundary_global_sequence)
         VALUES ($1, $2, $3, $4, '[]'::jsonb, $6, 'idle', $8)
         ON CONFLICT (tenant_id, session_id) DO UPDATE SET
           active_run_ids = (
             SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
             FROM jsonb_array_elements_text(${this.stateTable}.active_run_ids) AS value
             WHERE value <> $5
           ),
           due_at = CASE
             WHEN ${this.stateTable}.target_session_sequence > ${this.stateTable}.processed_session_sequence
             THEN $6::timestamptz + make_interval(mins => $7)
             ELSE NULL
           END,
           first_pending_at = CASE
             WHEN ${this.stateTable}.target_session_sequence > ${this.stateTable}.processed_session_sequence
             THEN COALESCE(${this.stateTable}.first_pending_at, $6)
             ELSE NULL
           END,
           status = CASE
             WHEN ${this.stateTable}.status IN ('blocked', 'throttled') THEN ${this.stateTable}.status
             WHEN ${this.stateTable}.target_session_sequence > ${this.stateTable}.processed_session_sequence THEN 'pending'
             ELSE 'idle'
           END,
           last_activity_at = GREATEST(COALESCE(${this.stateTable}.last_activity_at, $6), $6),
           last_boundary_global_sequence = $8,
           updated_at = NOW()
         WHERE ${this.stateTable}.last_boundary_global_sequence < $8`,
        [
          input.tenantId, input.userId, input.workspaceId, input.sessionId,
          input.runId, input.at, input.debounceMinutes, input.globalSequence,
        ],
      );
    }
  }

  /**
   * claim 一批到期可处理的 state（FOR UPDATE SKIP LOCKED）。
   * pending 只认最后一次 run_finished 后的 debounce due_at；不再存在连续对话
   * 60 分钟强制切批。retry_wait 按 next_attempt_at，running 的过期 lease 可回收。
   */
  async claimDue(input: {
    workerId: string; now: string; limit: number; leaseSeconds: number;
  }): Promise<ConsolidationState[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<StateRow>(
        `SELECT * FROM ${this.stateTable}
         WHERE target_session_sequence > processed_session_sequence
           AND active_run_ids = '[]'::jsonb
           AND (
             ((status = 'pending' AND due_at <= $1::timestamptz)
               OR (status = 'retry_wait' AND next_attempt_at <= $1::timestamptz))
             AND (lease_expires_at IS NULL OR lease_expires_at < $1::timestamptz)
             OR (status = 'running' AND lease_expires_at IS NOT NULL
                 AND lease_expires_at < $1::timestamptz)
           )
         ORDER BY COALESCE(due_at, next_attempt_at) ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [input.now, input.limit],
      );
      const claimed: ConsolidationState[] = [];
      for (const row of res.rows) {
        await client.query(
          `UPDATE ${this.stateTable}
           SET status = 'running', lease_owner = $3,
               lease_expires_at = $4::timestamptz + make_interval(secs => $5),
               updated_at = NOW()
           WHERE tenant_id = $1 AND session_id = $2`,
          [row.tenant_id, row.session_id, input.workerId, input.now, input.leaseSeconds],
        );
        claimed.push(mapState({ ...row, status: 'running', lease_owner: input.workerId }));
      }
      await client.query('COMMIT');
      return claimed;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 提交前续租并校验 fencing token；失败表示该 state 已被其他 worker 接管。 */
  async renewLease(input: {
    tenantId: string; sessionId: string; leaseOwner: string; now: string; leaseSeconds: number;
  }): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE ${this.stateTable} SET
         lease_expires_at = $4::timestamptz + make_interval(secs => $5), updated_at = NOW()
       WHERE tenant_id = $1 AND session_id = $2 AND status = 'running'
         AND active_run_ids = '[]'::jsonb
         AND lease_owner = $3 AND lease_expires_at >= $4::timestamptz`,
      [input.tenantId, input.sessionId, input.leaseOwner, input.now, input.leaseSeconds],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /** applied/noop：processed 推进到 toSequence；若 target 已超前则回到 pending，否则 idle。 */
  async markApplied(input: {
    tenantId: string; sessionId: string; toSequence: number; debounceMinutes: number; now: string;
    leaseOwner?: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.stateTable} SET
         processed_session_sequence = GREATEST(processed_session_sequence, $3),
         attempts = 0, next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
         status = CASE WHEN target_session_sequence > GREATEST(processed_session_sequence, $3)
                       THEN 'pending' ELSE 'idle' END,
         due_at = CASE WHEN target_session_sequence > GREATEST(processed_session_sequence, $3)
                       THEN $4::timestamptz + make_interval(mins => $5) ELSE NULL END,
         first_pending_at = CASE WHEN target_session_sequence > GREATEST(processed_session_sequence, $3)
                                 THEN COALESCE(first_pending_at, $4::timestamptz) ELSE NULL END,
         updated_at = NOW()
       WHERE tenant_id = $1 AND session_id = $2
         AND ($6::text IS NULL OR lease_owner = $6)`,
      [input.tenantId, input.sessionId, input.toSequence, input.now, input.debounceMinutes, input.leaseOwner ?? null],
    );
  }

  /** 会话已被政策排除：原子丢弃全部 backlog，后续新事件仍须重新通过 scanner 资格检查。 */
  async markIneligible(input: { tenantId: string; sessionId: string; leaseOwner?: string }): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.stateTable} SET
         processed_session_sequence = target_session_sequence,
         attempts = 0, next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
         status = 'idle', due_at = NULL, first_pending_at = NULL, updated_at = NOW()
       WHERE tenant_id = $1 AND session_id = $2
         AND ($3::text IS NULL OR lease_owner = $3)`,
      [input.tenantId, input.sessionId, input.leaseOwner ?? null],
    );
  }

  /** 可重试失败：attempts+1 并按退避序列重排；耗尽预算后暂时 blocked，后续新活动会恢复。 */
  async markFailed(input: {
    tenantId: string; sessionId: string; now: string;
    backoffMinutes: readonly number[]; maxRetries: number;
    permanent?: boolean; leaseOwner?: string;
  }): Promise<'retry_wait' | 'blocked'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ attempts: number }>(
        `UPDATE ${this.stateTable} SET
           attempts = attempts + 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE tenant_id = $1 AND session_id = $2
           AND ($3::text IS NULL OR lease_owner = $3)
         RETURNING attempts`,
        [input.tenantId, input.sessionId, input.leaseOwner ?? null],
      );
      if (res.rows.length === 0) {
        await client.query('COMMIT');
        return 'retry_wait';
      }
      const attempts = res.rows[0]!.attempts;
      const blocked = input.permanent === true || attempts > input.maxRetries;
      if (blocked) {
        await client.query(
          `UPDATE ${this.stateTable} SET status = 'blocked', next_attempt_at = NULL, updated_at = NOW()
           WHERE tenant_id = $1 AND session_id = $2`,
          [input.tenantId, input.sessionId],
        );
        await client.query('COMMIT');
        return 'blocked';
      }
      const backoff = input.backoffMinutes[Math.min(attempts - 1, input.backoffMinutes.length - 1)] ?? 60;
      await client.query(
        `UPDATE ${this.stateTable} SET
           status = 'retry_wait',
           next_attempt_at = $3::timestamptz + make_interval(mins => $4),
           updated_at = NOW()
         WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId, input.now, backoff],
      );
      await client.query('COMMIT');
      return 'retry_wait';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 兼容恢复旧版本配额留下的 throttled 状态；新版本不再产生该状态。 */
  async reviveThrottled(): Promise<number> {
    const res = await this.pool.query(
      `UPDATE ${this.stateTable} SET status = 'pending', updated_at = NOW()
       WHERE status = 'throttled' AND target_session_sequence > processed_session_sequence`,
    );
    return res.rowCount ?? 0;
  }

  /**
   * blocked 只是有界重试后的暂停态，不得永久粘住。启动时恢复 backlog，
   * worker 会重新执行资格检查并按真实原因处理；后续新活动也会直接恢复 pending。
   */
  async reviveLegacyBlocked(): Promise<number> {
    const res = await this.pool.query(
      `UPDATE ${this.stateTable} SET
         status = 'pending', attempts = 0, next_attempt_at = NULL,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE status = 'blocked' AND target_session_sequence > processed_session_sequence`,
    );
    return res.rowCount ?? 0;
  }

  async getState(tenantId: string, sessionId: string): Promise<ConsolidationState | null> {
    const res = await this.pool.query<StateRow>(
      `SELECT * FROM ${this.stateTable} WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    );
    return res.rows[0] ? mapState(res.rows[0]) : null;
  }

  // ── 幂等 run ledger ──────────────────────────────────────────

  /** INSERT；唯一冲突时返回已有 ledger 记录，避免同一范围重复创建执行记录。 */
  async insertOrGetRun(input: {
    idempotencyKey: string;
    tenantId: string; userId: string; workspaceId: string; sessionId: string;
    fromSessionSequence: number; toSessionSequence: number;
    promptVersion: number; modelRequested?: string;
  }): Promise<{ record: ConsolidationRunRecord; created: boolean }> {
    const id = randomUUID();
    const inserted = await this.pool.query(
      `INSERT INTO ${this.runsTable}
         (id, idempotency_key, tenant_id, user_id, workspace_id, session_id,
          from_session_sequence, to_session_sequence, status, prompt_version, model_requested, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'started', $9, $10, NOW())
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        id, input.idempotencyKey, input.tenantId, input.userId, input.workspaceId, input.sessionId,
        input.fromSessionSequence, input.toSessionSequence, input.promptVersion, input.modelRequested ?? null,
      ],
    );
    const res = await this.pool.query(
      `SELECT * FROM ${this.runsTable} WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const row = res.rows[0] as Record<string, unknown>;
    return { record: this.mapRun(row), created: (inserted.rowCount ?? 0) > 0 };
  }

  async updateRun(input: {
    idempotencyKey: string;
    status?: ConsolidationRunStatus;
    modelActual?: string;
    usageJson?: unknown;
    errorCode?: string;
    errorMessage?: string;
    incrementRetry?: boolean;
    applied?: boolean;
    finished?: boolean;
  }): Promise<void> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [input.idempotencyKey];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(`${sql} = $${params.length}`);
    };
    if (input.status !== undefined) push('status', input.status);
    if (input.modelActual !== undefined) push('model_actual', input.modelActual);
    if (input.usageJson !== undefined) push('usage_json', JSON.stringify(input.usageJson));
    if (input.errorCode !== undefined) push('error_code', input.errorCode);
    if (input.errorMessage !== undefined) push('error_message', input.errorMessage.slice(0, 2000));
    if (input.incrementRetry) sets.push('retry_count = retry_count + 1');
    if (input.applied) sets.push('applied_at = NOW()');
    if (input.finished) sets.push('finished_at = NOW()');
    await this.pool.query(
      `UPDATE ${this.runsTable} SET ${sets.join(', ')} WHERE idempotency_key = $1`,
      params,
    );
  }

  private mapRun(row: Record<string, unknown>): ConsolidationRunRecord {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      fromSessionSequence: Number(row.from_session_sequence),
      toSessionSequence: Number(row.to_session_sequence),
      status: String(row.status) as ConsolidationRunStatus,
      modelRequested: (row.model_requested as string | null) ?? null,
      modelActual: (row.model_actual as string | null) ?? null,
      promptVersion: Number(row.prompt_version),
      usageJson: row.usage_json,
      retryCount: Number(row.retry_count ?? 0),
      errorCode: (row.error_code as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
    };
  }

  // ── tombstone ────────────────────────────────────────────────

  async insertTombstone(input: {
    tenantId: string; userId: string; workspaceId: string;
    memoryKey?: string; normalizedFingerprint?: string; subjectText?: string;
    scope: TombstoneScope;
    source: MemoryTombstone['source'];
    reason?: string;
  }): Promise<MemoryTombstone> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO ${this.tombstonesTable}
         (id, tenant_id, user_id, workspace_id, memory_key, normalized_fingerprint, subject_text, scope, source, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id, input.tenantId, input.userId, input.workspaceId,
        input.memoryKey ?? null, input.normalizedFingerprint ?? null, input.subjectText ?? null,
        input.scope, input.source, input.reason ?? null,
      ],
    );
    return {
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      memoryKey: input.memoryKey ?? null,
      normalizedFingerprint: input.normalizedFingerprint ?? null,
      subjectText: input.subjectText ?? null,
      scope: input.scope,
      source: input.source,
      reason: input.reason ?? null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
  }

  async listActiveTombstones(tenantId: string, userId: string): Promise<MemoryTombstone[]> {
    const res = await this.pool.query(
      `SELECT * FROM ${this.tombstonesTable}
       WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [tenantId, userId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      memoryKey: (row.memory_key as string | null) ?? null,
      normalizedFingerprint: (row.normalized_fingerprint as string | null) ?? null,
      subjectText: (row.subject_text as string | null) ?? null,
      scope: String(row.scope) as TombstoneScope,
      source: String(row.source) as MemoryTombstone['source'],
      reason: (row.reason as string | null) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
      revokedAt: (row.revoked_at as Date | null)?.toISOString() ?? null,
    }));
  }

  async revokeTombstone(id: string, tenantId: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE ${this.tombstonesTable} SET revoked_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
      [id, tenantId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── per-user 文件提交锁（L1/L2/L3 共用，跨进程正确性边界）──────

  /**
   * PG advisory lock（session 级）。返回持锁 client；调用方必须在 finally 中
   * releaseCommitLock。锁名 = hashtext(tenant|user|memory-write)，与进程内
   * maintenanceLock 互补（后者只剩 fast-path 作用）。
   */
  async acquireCommitLock(tenantId: string, userId: string, timeoutMs = 15_000): Promise<
    { release: () => Promise<void> } | null
  > {
    const key = `${tenantId}|${userId}|memory-write`;
    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL statement_timeout = 0`).catch(() => undefined);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const res = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
          [key],
        );
        if (res.rows[0]?.locked) {
          return {
            release: async () => {
              try {
                await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
              } finally {
                client.release();
              }
            },
          };
        }
        if (Date.now() >= deadline) {
          client.release();
          return null;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    } catch (err) {
      client.release();
      throw err;
    }
  }
}
