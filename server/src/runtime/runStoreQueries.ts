import { randomUUID } from 'node:crypto';
import { cancelActiveRunsByUser } from './runTerminalLifecycle.js';
import { markRunStatus, markRunStatusIfCurrent } from './runStatusCas.js';
import type { ActiveRunCounts, LatestResponseSessionState, ListBackgroundTasksOptions, PgPool, ResponseSessionStatePatch, RunLeaseAdmission, RunRecord, RunStatus } from './runStoreTypes.js';
import { normalizeRunRecord, parseCount } from './runStoreRecordHelpers.js';
import type { LivenessReapResult, RunHeartbeatSource } from './runLiveness.js';
import { markRunLivenessStale, reapExpiredRunLiveness, renewRunLease } from './runStoreLivenessQueries.js';

/** SQL implementation for authoritative Runtime Run state. */
export class PgRunStoreQueries {
  constructor(
    readonly pool: PgPool,
    readonly runsTable: string,
    readonly messageSubmissionsTable: string,
    readonly steeringInputsTable: string,
    readonly toolInvocationsTable: string = runsTable.replace(/_runs$/, '_tool_invocations'),
  ) {}

  async markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> {
    if (status === 'cancelled') {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        // 先取得 run 行锁，再在同一事务内生成首次取消数据库时间；不能在可能阻塞的 UPDATE
        // target list 中提前求值，否则 cancelled_at 会早于真正的取消线性化点。
        const locked = await client.query<{ row_json: RunRecord }>(`
          SELECT row_to_json(${this.runsTable}.*) AS row_json
          FROM ${this.runsTable}
          WHERE run_id = $1
          FOR UPDATE
        `, [runId]);
        const existing = locked.rows[0]?.row_json;
        if (!existing) {
          await client.query('COMMIT');
          return null;
        }
        if (['completed', 'failed', 'orphaned'].includes(existing.status)) {
          await client.query('COMMIT');
          return normalizeRunRecord(existing);
        }
        const updated = await client.query<{ row_json: RunRecord }>(`
          WITH cancellation_time AS (SELECT clock_timestamp() AS now)
          UPDATE ${this.runsTable} run
          SET status = 'cancelled',
              status_reason = $2,
              updated_at = cancellation_time.now,
              cancelled_at = COALESCE(run.cancelled_at, cancellation_time.now),
              worker_id = NULL,
              lease_expires_at = NULL,
              liveness_state = CASE WHEN run.liveness_version IS NULL THEN NULL ELSE 'terminal' END,
              liveness_reason_code = CASE WHEN run.liveness_version IS NULL THEN NULL ELSE COALESCE($2, 'cancelled') END,
              liveness_detected_at = CASE WHEN run.liveness_version IS NULL THEN NULL ELSE cancellation_time.now END,
              liveness_version = CASE WHEN run.liveness_version IS NULL THEN NULL ELSE run.liveness_version + 1 END,
              metadata = ((run.metadata || $3::jsonb) - 'wakeMessage') || jsonb_build_object(
                'sandboxLifecycleTerminalAt', COALESCE(
                  CASE WHEN run.status = 'cancelled' THEN run.metadata->>'sandboxLifecycleTerminalAt' END,
                  run.cancelled_at::text,
                  run.completed_at::text,
                  run.failed_at::text,
                  CASE WHEN run.status = 'cancelled' THEN run.updated_at::text END,
                  cancellation_time.now::text
                )
              )
          FROM cancellation_time
          WHERE run.run_id = $1
            AND run.status NOT IN ('completed', 'failed', 'orphaned')
          RETURNING row_to_json(run.*) AS row_json
        `, [runId, reason ?? null, JSON.stringify(metadataPatch)]);
        await client.query('COMMIT');
        return updated.rows[0] ? normalizeRunRecord(updated.rows[0].row_json) : normalizeRunRecord(existing);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    return markRunStatus(
      { pool: this.pool, runsTable: this.runsTable, normalizeRunRecord },
      runId,
      status,
      reason,
      metadataPatch,
    );
  }

  async activateStagedRun(runId: string): Promise<RunRecord | null> {
    return this.updateSchedulerState(runId, "metadata->>'schedulerState' = 'staged'", 'ready', false);
  }

  /**
   * Interaction responses are deliberately staged before their durable event is
   * appended. Unlike generic Taskboard staging, these transitions are fenced by
   * the persisted interaction key (including its per-attempt claimId).
   */
  async claimPersistedInteractionResume(
    runId: string,
    expectedStatuses: readonly RunStatus[],
    reason: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<RunRecord | null> {
    const now = new Date().toISOString();
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET status = 'pending',
          status_reason = $3,
          worker_id = NULL,
          lease_expires_at = NULL,
          liveness_state = CASE WHEN liveness_version IS NULL THEN NULL ELSE 'active' END,
          liveness_reason_code = CASE WHEN liveness_version IS NULL THEN NULL ELSE $3 END,
          liveness_detected_at = CASE WHEN liveness_version IS NULL THEN NULL ELSE $4::timestamptz END,
          liveness_version = CASE WHEN liveness_version IS NULL THEN NULL ELSE liveness_version + 1 END,
          updated_at = $4,
          metadata = jsonb_set(metadata || $5::jsonb, '{schedulerState}', '"staged"'::jsonb, true)
      WHERE run_id = $1
        AND status = ANY($2::text[])
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, expectedStatuses, reason, now, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async listStagedPersistedInteractionResumes(limit = 50): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.runsTable} run
      WHERE status = 'pending'
        AND metadata->>'schedulerState' = 'staged'
        AND jsonb_typeof(metadata->'persistedInteractionResumeClaim') = 'object'
      ORDER BY updated_at ASC, run_id ASC
      LIMIT $1
    `, [limit]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }

  async activatePersistedInteractionResume(
    runId: string,
    claim: Record<string, unknown>,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata || $3::jsonb, '{schedulerState}', '"ready"'::jsonb, true),
          updated_at = clock_timestamp()
      WHERE run_id = $1
        AND status = 'pending'
        AND metadata->>'schedulerState' = 'staged'
        AND metadata->'persistedInteractionResumeClaim' @> $2::jsonb
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, JSON.stringify(claim), JSON.stringify(metadataPatch)]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async rollbackPersistedInteractionResume(
    runId: string,
    claim: Record<string, unknown>,
    waitingStatus: 'waiting_user' | 'waiting_approval',
    reason?: string,
  ): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET status = $3,
          status_reason = $4,
          worker_id = NULL,
          lease_expires_at = NULL,
          liveness_state = CASE WHEN liveness_version IS NULL THEN NULL ELSE 'waiting_interaction' END,
          liveness_reason_code = CASE WHEN liveness_version IS NULL THEN NULL ELSE $4 END,
          liveness_detected_at = CASE WHEN liveness_version IS NULL THEN NULL ELSE clock_timestamp() END,
          liveness_version = CASE WHEN liveness_version IS NULL THEN NULL ELSE liveness_version + 1 END,
          updated_at = clock_timestamp(),
          metadata = metadata
            - 'schedulerState'
            - 'persistedInteractionResumeClaim'
            - 'resumeInteraction'
            - 'resumeApproval'
            - 'resumeInteractionConsumedAt'
            - 'resumeInteractionConsumedId'
            - 'resumeApprovalConsumedAt'
            - 'resumeApprovalConsumedId'
      WHERE run_id = $1
        AND status = 'pending'
        AND metadata->>'schedulerState' = 'staged'
        AND metadata->'persistedInteractionResumeClaim' @> $2::jsonb
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, JSON.stringify(claim), waitingStatus, reason ?? null]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async stagePendingRun(runId: string): Promise<RunRecord | null> {
    return this.updateSchedulerState(runId, "NOT (metadata ? 'schedulerState')", 'staged', true);
  }

  private async updateSchedulerState(
    runId: string,
    schedulerStatePredicate: string,
    schedulerState: 'staged' | 'ready',
    requireTaskboardExecution: boolean,
  ): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{schedulerState}', to_jsonb($2::text), true),
          updated_at = clock_timestamp()
      WHERE run_id = $1
        AND status = 'pending'
        ${requireTaskboardExecution ? "AND metadata->>'taskboardExecution' = 'true'" : ''}
        AND ${schedulerStatePredicate}
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, schedulerState]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : this.get(runId);
  }

  async cancelPendingTaskboardRun(runId: string, reason: string): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      WITH cancellation_time AS (SELECT clock_timestamp() AS now)
      UPDATE ${this.runsTable}
      SET status = 'cancelled',
          status_reason = $2,
          updated_at = cancellation_time.now,
          cancelled_at = COALESCE(cancelled_at, cancellation_time.now),
          worker_id = NULL,
          lease_expires_at = NULL,
          liveness_state = CASE WHEN liveness_version IS NULL THEN NULL ELSE 'terminal' END,
          liveness_reason_code = CASE WHEN liveness_version IS NULL THEN NULL ELSE $2 END,
          liveness_detected_at = CASE WHEN liveness_version IS NULL THEN NULL ELSE cancellation_time.now END,
          liveness_version = CASE WHEN liveness_version IS NULL THEN NULL ELSE liveness_version + 1 END,
          metadata = metadata - 'wakeMessage'
      FROM cancellation_time
      WHERE run_id = $1
        AND status = 'pending'
        AND metadata->>'taskboardExecution' = 'true'
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, reason]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : this.get(runId);
  }

  async markStatusIfCurrent(
    runId: string,
    expectedStatuses: readonly RunStatus[],
    status: RunStatus,
    reason?: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    return markRunStatusIfCurrent({
      pool: this.pool,
      runsTable: this.runsTable,
      normalizeRunRecord,
    }, runId, expectedStatuses, status, reason, metadataPatch);
  }

  async patchMetadata(runId: string, metadataPatch: Record<string, unknown>): Promise<RunRecord | null> {
    const now = new Date().toISOString();
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET metadata = metadata || ($2::jsonb - 'sandboxLifecycleTerminalAt'),
          updated_at = $3
      WHERE run_id = $1
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, JSON.stringify(metadataPatch), now]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async get(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`SELECT row_to_json(${this.runsTable}.*) AS row_json FROM ${this.runsTable} WHERE run_id = $1`, [runId]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async cancelActiveByUser(userId: string, reason: string): Promise<number> {
    return cancelActiveRunsByUser(this, userId, reason);
  }

  async cancelActiveByTenant(tenantId: string, reason: string): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.pool.query(`
      UPDATE ${this.runsTable}
      SET status = 'cancelled',
          status_reason = $2,
          updated_at = $3,
          cancelled_at = $3,
          metadata = metadata - 'wakeMessage'
      WHERE tenant_id = $1
        AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
    `, [tenantId, reason, now]);
    return result.rowCount ?? 0;
  }

  async listActiveByUser(userId: string): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json FROM ${this.runsTable} run
      WHERE user_id=$1 AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
      ORDER BY updated_at,run_id
    `, [userId]);
    return result.rows.map(row => normalizeRunRecord(row.row_json));
  }

  /** TASK-256：单条 UPDATE 原子收敛账户批准策略，防止逐 run 更新只成功一部分。 */
  async updateApprovalPolicyForActiveByUser(
    userId: string,
    approvalPolicy: Record<string, unknown> | null,
  ): Promise<string[]> {
    const result = await this.pool.query<{ run_id: string }>(`
      UPDATE ${this.runsTable}
      SET metadata=jsonb_set(COALESCE(metadata, '{}'::jsonb), '{approvalPolicy}', $2::jsonb, true),
          status_reason='approval_policy_updated', updated_at=now()
      WHERE user_id=$1
        AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
        AND COALESCE(metadata->'approvalPolicy', 'null'::jsonb) IS DISTINCT FROM $2::jsonb
      RETURNING run_id
    `, [userId, JSON.stringify(approvalPolicy)]);
    return result.rows.map(row => row.run_id);
  }

  async findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    // 只有 message_submissions 中已提交的记录才是“已受理”。仅有 runs.idempotency_key
    // 的预创建/失败记录不能短路新的请求；管理员代操作也必须按认证 submitter 域查询。
    const userScope = userId ?? '__anonymous__';
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.messageSubmissionsTable} submission
      JOIN ${this.runsTable} run ON run.run_id = submission.run_id
      WHERE submission.user_scope = $1
        AND submission.client_message_id = $2
      LIMIT 1
    `, [userScope, idempotencyKey]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async getActiveBySession(sessionId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.runsTable} run
      WHERE run.session_id = $1
        AND run.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
        AND NOT EXISTS (
          SELECT 1
          FROM ${this.steeringInputsTable} input
          JOIN ${this.runsTable} target ON target.run_id = input.target_run_id
          WHERE input.source_run_id = run.run_id
            AND (
              (
                input.state = 'reserved'
                AND target.status NOT IN ('completed','failed','cancelled','orphaned')
              )
              OR (
                input.state = 'pending'
                AND target.status IN ('pending','running','waiting_hand')
                AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open'
              )
            )
        )
      ORDER BY
        CASE run.status
          WHEN 'running' THEN 0
          WHEN 'waiting_approval' THEN 0
          WHEN 'waiting_user' THEN 0
          WHEN 'waiting_hand' THEN 0
          ELSE 1
        END,
        run.updated_at DESC
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
      FROM ${this.runsTable} run
      WHERE status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
        AND NOT EXISTS (
          SELECT 1
          FROM ${this.steeringInputsTable} input
          JOIN ${this.runsTable} target ON target.run_id = input.target_run_id
          WHERE input.source_run_id = run.run_id
            AND (
              (
                input.state = 'reserved'
                AND target.status NOT IN ('completed','failed','cancelled','orphaned')
              )
              OR (
                input.state = 'pending'
                AND target.status IN ('pending','running','waiting_hand')
                AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open'
              )
            )
        )
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
        AND COALESCE(metadata->>'sandboxCleanupCarrier', 'false') <> 'true'
        AND ($2::timestamptz IS NULL OR updated_at < $2::timestamptz)
      ORDER BY updated_at DESC
      LIMIT $3
    `, [sessionId, options.beforeUpdatedAt ?? null, limit]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }

  async listSessionIdsByTenant(tenantId: string): Promise<string[]> {
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM ${this.runsTable}
       WHERE tenant_id = $1
         AND COALESCE(metadata->>'sandboxCleanupCarrier', 'false') <> 'true'`,
      [tenantId],
    );
    return result.rows.map(row => row.session_id);
  }

  async deleteByTenant(tenantId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        DELETE FROM ${this.steeringInputsTable} input
        USING ${this.runsTable} source
        WHERE source.run_id = input.source_run_id AND source.tenant_id = $1
      `, [tenantId]);
      const result = await client.query(`DELETE FROM ${this.runsTable} WHERE tenant_id = $1`, [tenantId]);
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Legacy expired rows remain recoverable; versioned M40 rows are owned exclusively by the two-phase reaper. */
  async listRecoverable(now = new Date()): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.runsTable} run
      WHERE (
        run.status = 'pending'
        OR (
          run.status = 'running'
          AND run.liveness_version IS NULL
          AND (run.lease_expires_at IS NULL OR run.lease_expires_at < $1)
        )
      )
        AND NOT (
          run.status = 'pending'
          AND COALESCE(run.metadata->>'schedulerState', '') = 'staged'
        )
        AND NOT (
          run.metadata->>'backgroundTaskVersion' = '2'
          AND COALESCE(run.metadata->>'backgroundTaskReady', 'false') <> 'true'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${this.steeringInputsTable} input
          JOIN ${this.runsTable} target ON target.run_id = input.target_run_id
          WHERE input.source_run_id = run.run_id
            AND (
              (
                input.state = 'reserved'
                AND target.status NOT IN ('completed','failed','cancelled','orphaned')
              )
              OR (
                input.state = 'pending'
                AND target.status IN ('pending','running','waiting_hand')
                AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open'
              )
            )
        )
      ORDER BY run.enqueue_seq ASC
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
          metadata = (metadata || $5::jsonb) - 'wakeMessage'
      WHERE run_id = $1
        AND status = 'waiting_approval'
        AND updated_at < $2::timestamptz
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, cutoff.toISOString(), reason, now, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async acquireLease(
    runId: string,
    workerId: string,
    leaseMs: number,
    now = new Date(),
    maxConcurrentRuns?: number,
    admission?: RunLeaseAdmission,
  ): Promise<RunRecord | null> {
    if (maxConcurrentRuns !== undefined && (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1)) {
      throw new Error('maxConcurrentRuns must be a positive integer');
    }
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const nowIso = now.toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let inheritsParentCapacity = false;
      // 固定锁顺序：统一父子 Run 容量 → 会话。每次重试都在同一事务里竞选父槽；
      // 当前继承者结束后，已等待兄弟可接棒，且跨进程仍保证单父最多一个继承者。
      if (maxConcurrentRuns !== undefined) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `${this.runsTable}:scheduler-capacity`,
        ]);
        const inheritedParentRunId = admission?.inheritFromRunId?.trim();
        if (inheritedParentRunId) {
          const eligibility = await client.query<{
            parent_active: boolean;
            candidate_eligible: boolean;
            inherited_active: boolean;
          }>(`
            SELECT
              EXISTS (
                SELECT 1 FROM ${this.runsTable} parent_run
                WHERE parent_run.run_id = $1
                  AND parent_run.status = 'running'
                  AND parent_run.lease_expires_at > $2::timestamptz
              ) AS parent_active,
              EXISTS (
                SELECT 1 FROM ${this.runsTable} child_run
                WHERE child_run.run_id = $3
                  AND child_run.metadata->>'subagent' = 'true'
                  AND child_run.metadata->>'parentRunId' = $1
              ) AS candidate_eligible,
              EXISTS (
                SELECT 1 FROM ${this.runsTable} inherited_run
                WHERE inherited_run.run_id <> $3
                  AND inherited_run.status = 'running'
                  AND inherited_run.lease_expires_at > $2::timestamptz
                  AND inherited_run.metadata->>'subagentCapacityInherited' = 'true'
                  AND inherited_run.metadata->>'parentRunId' = $1
              ) AS inherited_active
          `, [inheritedParentRunId, nowIso, runId]);
          const row = eligibility.rows[0];
          if (!row?.parent_active || !row.candidate_eligible) {
            await client.query('ROLLBACK');
            return null;
          }
          inheritsParentCapacity = !row.inherited_active;
        }
        if (!inheritsParentCapacity) {
          const countResult = await client.query<{ active_count: string | number }>(`
            SELECT COUNT(*) AS active_count
            FROM ${this.runsTable} active_run
            WHERE active_run.status = 'running'
              AND active_run.lease_expires_at > $1::timestamptz
              AND NOT (
                active_run.metadata->>'subagentCapacityInherited' = 'true'
                AND EXISTS (
                  SELECT 1
                  FROM ${this.runsTable} parent_run
                  WHERE parent_run.run_id = active_run.metadata->>'parentRunId'
                    AND parent_run.status = 'running'
                    AND parent_run.lease_expires_at > $1::timestamptz
                )
              )
          `, [nowIso]);
          const reserved = admission?.foreground
            ? 0
            : Math.min(Math.max(0, admission?.foregroundReservedRuns ?? 0), Math.max(0, maxConcurrentRuns - 1));
          if (parseCount(countResult.rows[0]?.active_count) >= maxConcurrentRuns - reserved) {
            await client.query('ROLLBACK');
            return null;
          }
        }
      }

      const candidate = await client.query<{ session_id: string }>(`
        SELECT session_id FROM ${this.runsTable} WHERE run_id = $1
      `, [runId]);
      const sessionId = candidate.rows[0]?.session_id;
      if (!sessionId) {
        await client.query('ROLLBACK');
        return null;
      }
      // 数据库级会话闸门：跨进程原子检查“没有其他 executing run”并取得本 run lease。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${this.runsTable}:session-dispatch:${sessionId}`,
      ]);
      const result = await client.query<{ row_json: RunRecord }>(`
        UPDATE ${this.runsTable} candidate
        SET status = 'running',
            worker_id = $2,
            lease_expires_at = $3,
            last_heartbeat_at = $4,
            liveness_state = 'busy',
            liveness_reason_code = NULL,
            liveness_detected_at = $4,
            liveness_version = COALESCE(candidate.liveness_version, 0) + 1,
            started_at = COALESCE(candidate.started_at, $4),
            updated_at = $4,
            metadata = CASE
              WHEN $5::boolean THEN jsonb_set(candidate.metadata, '{subagentCapacityInherited}', 'true'::jsonb, true)
              ELSE candidate.metadata - 'subagentCapacityInherited'
            END
        WHERE candidate.run_id = $1
          AND (
            candidate.status = 'pending'
            OR (
              candidate.status = 'running'
              AND candidate.liveness_version IS NULL
              AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at < $4)
            )
          )
          AND NOT (
            candidate.status = 'pending'
            AND COALESCE(candidate.metadata->>'schedulerState', '') = 'staged'
          )
          AND NOT (
            candidate.metadata->>'backgroundTaskVersion' = '2'
            AND COALESCE(candidate.metadata->>'backgroundTaskReady', 'false') <> 'true'
          )
          AND (
            candidate.status <> 'pending'
            OR NOT EXISTS (
              SELECT 1
              FROM ${this.runsTable} predecessor
              WHERE predecessor.session_id = candidate.session_id
                AND predecessor.status = 'pending'
                AND predecessor.run_id <> candidate.run_id
                AND predecessor.enqueue_seq < candidate.enqueue_seq
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.runsTable} active
            WHERE active.session_id = candidate.session_id
              AND active.run_id <> candidate.run_id
              AND active.status IN ('running','waiting_hand')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.steeringInputsTable} input
            JOIN ${this.runsTable} target ON target.run_id = input.target_run_id
            WHERE input.source_run_id = candidate.run_id
              AND (
                (
                  input.state = 'reserved'
                  AND target.status NOT IN ('completed','failed','cancelled','orphaned')
                )
                OR (
                  input.state = 'pending'
                  AND target.status IN ('pending','running','waiting_hand')
                  AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open'
                )
              )
          )
        RETURNING row_to_json(candidate.*) AS row_json
      `, [runId, workerId, leaseExpiresAt, nowIso, inheritsParentCapacity]);
      await client.query('COMMIT');
      return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async renewLease(
    runId: string,
    workerId: string,
    leaseMs: number,
    now = new Date(),
    source: RunHeartbeatSource = 'worker',
  ): Promise<RunRecord | null> {
    return renewRunLease(this, runId, workerId, leaseMs, now, source);
  }

  async markLivenessStale(
    runId: string,
    workerId: string,
    reasonCode: string,
    now = new Date(),
  ): Promise<RunRecord | null> {
    return markRunLivenessStale(this, runId, workerId, reasonCode, now);
  }

  async reapExpiredLiveness(now: Date, staleGraceMs: number, limit = 50): Promise<LivenessReapResult> {
    return reapExpiredRunLiveness(this, now, staleGraceMs, limit);
  }

  async retryOrphanedUserMessage(
    submitterUserId: string | undefined,
    clientMsgId: string,
    now = new Date(),
  ): Promise<RunRecord | null> {
    const scope = submitterUserId ?? '__anonymous__';
    const retryRunId = `retry-${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${this.runsTable}:explicit-retry:${scope}:${clientMsgId}`,
      ]);
      const sourceResult = await client.query<{ row_json: RunRecord }>(`
        SELECT row_to_json(run.*) AS row_json
        FROM ${this.runsTable} run
        JOIN ${this.messageSubmissionsTable} submission ON submission.run_id = run.run_id
        WHERE submission.user_scope = $1 AND submission.client_message_id = $2
        FOR UPDATE OF run
      `, [scope, clientMsgId]);
      const sourceRaw = sourceResult.rows[0]?.row_json;
      if (!sourceRaw) { await client.query('COMMIT'); return null; }
      const source = normalizeRunRecord(sourceRaw);
      const existingRetryRunId = typeof source.metadata?.explicitRetryRunId === 'string'
        ? source.metadata.explicitRetryRunId : undefined;
      if (existingRetryRunId) {
        const existing = await client.query<{ row_json: RunRecord }>(`
          SELECT row_to_json(${this.runsTable}.*) AS row_json FROM ${this.runsTable} WHERE run_id = $1
        `, [existingRetryRunId]);
        await client.query('COMMIT');
        return existing.rows[0] ? normalizeRunRecord(existing.rows[0].row_json) : null;
      }
      const unsafe = source.status !== 'orphaned'
        || !source.liveness
        || source.liveness.reasonCode === 'external_tool_outcome_unknown';
      if (unsafe) { await client.query('COMMIT'); return null; }
      const runningTool = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM ${this.toolInvocationsTable}
          WHERE run_id = $1 AND status = 'running'
        ) AS exists
      `, [source.runId]);
      if (runningTool.rows[0]?.exists) { await client.query('COMMIT'); return null; }
      const created = await client.query<{ row_json: RunRecord }>(`
        INSERT INTO ${this.runsTable}
          (run_id, session_id, user_id, tenant_id, submitter_scope, status, status_reason, model, channel,
           requested_at, updated_at, idempotency_key, execution_target, workspace_id, sandbox_scope_id, metadata,
           liveness_state, liveness_reason_code, liveness_detected_at, liveness_version)
        SELECT $3, session_id, user_id, tenant_id, submitter_scope, 'pending', 'explicit_client_retry', model, channel,
               $4::timestamptz, $4::timestamptz, $2, execution_target, workspace_id, sandbox_scope_id,
               (metadata || jsonb_build_object('retryOf', run_id, 'explicitRetryAt', $4::text))
                 - 'externalToolOutcomeUnknown' - 'livenessTerminalizedBy',
               'active', 'explicit_client_retry', $4::timestamptz, 1
        FROM ${this.runsTable}
        WHERE run_id = $1
        RETURNING row_to_json(${this.runsTable}.*) AS row_json
      `, [source.runId, clientMsgId, retryRunId, now.toISOString()]);
      if (!created.rows[0]) throw new Error(`Explicit retry source disappeared: ${source.runId}`);
      await client.query(`
        UPDATE ${this.runsTable}
        SET metadata = metadata || jsonb_build_object('explicitRetryRunId', $2::text, 'explicitRetryAt', $3::text)
        WHERE run_id = $1 AND status = 'orphaned'
      `, [source.runId, retryRunId, now.toISOString()]);
      await client.query('COMMIT');
      return normalizeRunRecord(created.rows[0].row_json);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelUserMessageByClientMsgId(
    submitterUserId: string | undefined,
    clientMsgId: string,
    reason = 'explicit_client_cancel',
    _now = new Date(),
  ): Promise<RunRecord | null> {
    const scope = submitterUserId ?? '__anonymous__';
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      WITH target AS MATERIALIZED (
        SELECT submission.run_id
        FROM ${this.messageSubmissionsTable} submission
        WHERE submission.user_scope = $1 AND submission.client_message_id = $2
      ), locked AS MATERIALIZED (
        SELECT run.run_id
        FROM ${this.runsTable} run
        JOIN target ON target.run_id = run.run_id
        FOR UPDATE OF run
      ), cancellation_time AS MATERIALIZED (
        SELECT clock_timestamp() AS now FROM locked
      ), updated AS (
        UPDATE ${this.runsTable} run
        SET status = 'cancelled',
            status_reason = $3,
            worker_id = NULL,
            lease_expires_at = NULL,
            cancelled_at = COALESCE(run.cancelled_at, cancellation_time.now),
            updated_at = cancellation_time.now,
            liveness_state = CASE WHEN run.liveness_version IS NULL THEN NULL ELSE 'terminal' END,
            liveness_reason_code = CASE WHEN run.liveness_version IS NULL THEN NULL ELSE $3 END,
            liveness_detected_at = CASE WHEN run.liveness_version IS NULL THEN NULL ELSE cancellation_time.now END,
            liveness_version = CASE WHEN run.liveness_version IS NULL THEN NULL ELSE run.liveness_version + 1 END,
            metadata = (run.metadata - 'wakeMessage') || jsonb_build_object(
              'sandboxLifecycleTerminalAt', COALESCE(
                run.metadata->>'sandboxLifecycleTerminalAt',
                run.cancelled_at::text,
                run.completed_at::text,
                run.failed_at::text,
                cancellation_time.now::text
              )
            )
        FROM cancellation_time
        WHERE run.run_id = (SELECT run_id FROM locked)
          AND run.status NOT IN ('completed','failed','cancelled','orphaned')
        RETURNING row_to_json(run.*) AS row_json
      )
      SELECT row_json FROM updated
      UNION ALL
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.runsTable} run
      JOIN locked ON locked.run_id = run.run_id
      WHERE NOT EXISTS (SELECT 1 FROM updated)
    `, [scope, clientMsgId, reason]);
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
    if (patch.lastResponseProfileDigest !== undefined) {
      sets.push(`last_response_profile_digest = $${nextIdx}`);
      params.push(patch.lastResponseProfileDigest);
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
      last_response_profile_digest: string | null;
      cumulative_input_tokens: string | number | null;
    }>(`
      SELECT run_id, last_response_id, last_response_expire_at, actual_model_seen, last_response_model, last_response_profile_digest, cumulative_input_tokens
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
      ...(row.last_response_profile_digest ? { lastResponseProfileDigest: row.last_response_profile_digest } : {}),
      ...(cumulative ? { cumulativeInputTokens: cumulative } : {}),
    };
  }

  async findBackgroundTasksByIdentifier(
    parentSessionId: string,
    identifier: string,
    options: Pick<ListBackgroundTasksOptions, 'userId' | 'tenantId'> = {},
  ): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE metadata->>'backgroundTask' = 'true'
        AND metadata->>'parentSessionId' = $1
        AND (run_id = $2 OR UPPER(metadata->>'shortTaskId') = UPPER($2))
        AND ($3::text IS NULL OR user_id = $3)
        AND ($4::text IS NULL OR tenant_id = $4)
      ORDER BY requested_at DESC
      LIMIT 2
    `, [parentSessionId, identifier, options.userId ?? null, options.tenantId ?? null]);
    return result.rows.map((entry) => normalizeRunRecord(entry.row_json));
  }

  async clearResponseSessionStateBySession(sessionId: string): Promise<number> {
    const result = await this.pool.query(`
      UPDATE ${this.runsTable}
      SET last_response_id = NULL, last_response_profile_digest = NULL
      WHERE session_id = $1 AND last_response_id IS NOT NULL
    `, [sessionId]);
    return result.rowCount ?? 0;
  }

}
