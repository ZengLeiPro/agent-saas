import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { invokeWithPgActiveRunGate } from './pgToolInvocationRunGate.js';

export type ToolInvocationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ToolInvocationRecord {
  invocationId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  executionTarget: ExecutionTargetKind;
  tenantId?: string;
  status: ToolInvocationStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  cancelDeliveredAt?: string;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface StartToolInvocationInput {
  invocationId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  executionTarget: ExecutionTargetKind;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

export type ToolInvocationRunGateResult<T> =
  | { invoked: true; result: T }
  | {
      invoked: false;
      reason: 'run_missing' | 'run_terminal' | 'invocation_missing' | 'invocation_terminal' | 'cancel_requested' | 'invocation_claimed';
      invocation: ToolInvocationRecord | null;
      runStatus?: string;
    };

export interface ToolInvocationStore {
  start(input: StartToolInvocationInput): Promise<ToolInvocationRecord>;
  /**
   * 在 run 与 invocation 的权威门禁内同步启动副作用。PG 实现持有共享行锁直到
   * invoke 回调返回 Promise，确保终态提交与实际工具启动存在唯一先后顺序。
   */
  invokeWithActiveRunGate<T>(
    runId: string,
    invocationId: string,
    invoke: () => Promise<T>,
    readRunStatus?: () => Promise<string | null>,
  ): Promise<ToolInvocationRunGateResult<T>>;
  complete(invocationId: string, status: Exclude<ToolInvocationStatus, 'running'>, error?: string): Promise<ToolInvocationRecord | null>;
  requestCancel(invocationId: string, reason?: string, metadataPatch?: Record<string, unknown>): Promise<ToolInvocationRecord | null>;
  /** 原子登记首次取消请求；只有 created=true 的调用方负责发布即时事件。 */
  requestCancelOnce(
    invocationId: string,
    reason?: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<{ record: ToolInvocationRecord; created: boolean } | null>;
  /**
   * 恢复 cancelled run 的漏登记 outbox。只有 invocation 在取消线性化点仍在运行，
   * 或在该时间点之后终态化时才原子登记，避免恢复快照 TOCTOU 误取消。
   */
  requestCancelOnceAfterRunCancellation(
    invocationId: string,
    runCancelledAt: string,
    reason?: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<{ record: ToolInvocationRecord; created: boolean } | null>;
  /** 为外部 DELETE 副作用获取短租约；并发消费者只有一个能取得 claim。 */
  claimCancelDelivery(
    invocationId: string,
    claimId: string,
    leaseMs: number,
    now?: Date,
  ): Promise<ToolInvocationRecord | null>;
  markCancelDeliveryAttempt(
    invocationId: string,
    metadataPatch?: Record<string, unknown>,
    claimId?: string,
  ): Promise<ToolInvocationRecord | null>;
  markCancelDelivered(
    invocationId: string,
    metadataPatch?: Record<string, unknown>,
    claimId?: string,
  ): Promise<ToolInvocationRecord | null>;
  get(invocationId: string): Promise<ToolInvocationRecord | null>;
  listRunning(sessionId?: string): Promise<ToolInvocationRecord[]>;
  listCancelRequested(sessionId?: string): Promise<ToolInvocationRecord[]>;
  /** 启动恢复时查找属于 cancelled run、但尚未登记 durable cancel outbox 的调用。 */
  listCancelRecoveryCandidates?(): Promise<ToolInvocationRecord[]>;
}

export interface AdminToolInvocationQuery {
  tenantId?: string;
  userId?: string;
  toolName?: string;
  skillName?: string;
  status?: ToolInvocationStatus;
  reasonContains?: string;
  hours?: number;
  limit?: number;
  offset?: number;
}

export interface AdminToolInvocationEntry {
  invocationId: string;
  runId: string;
  sessionId: string;
  tenantId: string;
  userId: string | null;
  username: string | null;
  toolName: string;
  skillName: string | null;
  executionTarget: ExecutionTargetKind;
  status: ToolInvocationStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface AdminToolInvocationResult {
  items: AdminToolInvocationEntry[];
  summary: {
    total: number;
    failed: number;
    affectedTenants: number;
    affectedUsers: number;
    skillCalls: number;
    skillCallsTracked: number;
  };
  byTool: Array<{
    toolName: string;
    count: number;
    failed: number;
    avgDurationMs: number | null;
    lastCalledAt: string;
  }>;
  bySkill: Array<{
    skillName: string;
    count: number;
    failed: number;
    affectedTenants: number;
    affectedUsers: number;
    lastCalledAt: string;
  }>;
}

export class InMemoryToolInvocationStore implements ToolInvocationStore {
  private readonly invocations = new Map<string, ToolInvocationRecord>();

  async start(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    const now = new Date().toISOString();
    const existing = this.invocations.get(input.invocationId);
    if (existing) {
      const updated: ToolInvocationRecord = {
        ...existing,
        updatedAt: now,
        tenantId: input.tenantId ?? existing.tenantId,
        metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
      };
      this.invocations.set(input.invocationId, updated);
      return updated;
    }
    const record: ToolInvocationRecord = {
      invocationId: input.invocationId,
      runId: input.runId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      executionTarget: input.executionTarget,
      tenantId: input.tenantId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    };
    this.invocations.set(input.invocationId, record);
    return record;
  }

  async invokeWithActiveRunGate<T>(
    runId: string,
    invocationId: string,
    invoke: () => Promise<T>,
    readRunStatus?: () => Promise<string | null>,
  ): Promise<ToolInvocationRunGateResult<T>> {
    const runStatus = readRunStatus ? await readRunStatus() : null;
    const invocation = this.invocations.get(invocationId) ?? null;
    if (!invocation || invocation.runId !== runId) {
      return { invoked: false, reason: 'invocation_missing', invocation: null };
    }
    if (typeof invocation.metadata.invokeClaimedAt === 'string') {
      return { invoked: false, reason: 'invocation_claimed', invocation };
    }
    if (readRunStatus && !runStatus) {
      return { invoked: false, reason: 'run_missing', invocation };
    }
    if (runStatus && ['completed', 'failed', 'cancelled', 'orphaned'].includes(runStatus)) {
      return { invoked: false, reason: 'run_terminal', invocation, runStatus };
    }
    if (invocation.status !== 'running') {
      return { invoked: false, reason: 'invocation_terminal', invocation };
    }
    if (invocation.cancelRequestedAt) {
      return { invoked: false, reason: 'cancel_requested', invocation };
    }
    const claimed: ToolInvocationRecord = {
      ...invocation,
      updatedAt: new Date().toISOString(),
      metadata: { ...invocation.metadata, invokeClaimedAt: new Date().toISOString() },
    };
    this.invocations.set(invocationId, claimed);
    return { invoked: true, result: await invoke() };
  }

  async complete(invocationId: string, status: Exclude<ToolInvocationStatus, 'running'>, error?: string): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record || record.status !== 'running') return null;
    const updated: ToolInvocationRecord = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async requestCancel(invocationId: string, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record) return null;
    const now = new Date().toISOString();
    const updated: ToolInvocationRecord = {
      ...record,
      cancelRequestedAt: record.cancelRequestedAt ?? now,
      cancelReason: record.cancelReason ?? reason,
      updatedAt: now,
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async requestCancelOnce(
    invocationId: string,
    reason?: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<{ record: ToolInvocationRecord; created: boolean } | null> {
    const existing = this.invocations.get(invocationId);
    if (!existing) return null;
    if (existing.cancelRequestedAt) {
      const record = await this.requestCancel(invocationId, reason, metadataPatch);
      return record ? { record, created: false } : null;
    }
    const record = await this.requestCancel(invocationId, reason, metadataPatch);
    return record ? { record, created: true } : null;
  }

  async requestCancelOnceAfterRunCancellation(
    invocationId: string,
    runCancelledAt: string,
    reason?: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<{ record: ToolInvocationRecord; created: boolean } | null> {
    const existing = this.invocations.get(invocationId);
    if (!existing) return null;
    if (existing.cancelRequestedAt) return { record: existing, created: false };
    const eligible = existing.status === 'running'
      || (existing.completedAt !== undefined && Date.parse(existing.completedAt) >= Date.parse(runCancelledAt));
    if (!eligible) return null;
    const record = await this.requestCancel(invocationId, reason, metadataPatch);
    return record ? { record, created: true } : null;
  }

  async claimCancelDelivery(
    invocationId: string,
    claimId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record || !record.cancelRequestedAt || record.cancelDeliveredAt) return null;
    const nextAttemptAt = typeof record.metadata.cancelDeliveryNextAttemptAt === 'string'
      ? Date.parse(record.metadata.cancelDeliveryNextAttemptAt)
      : Number.NaN;
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now.getTime()) return null;
    const currentExpiry = typeof record.metadata.cancelDeliveryClaimExpiresAt === 'string'
      ? Date.parse(record.metadata.cancelDeliveryClaimExpiresAt)
      : Number.NaN;
    if (Number.isFinite(currentExpiry) && currentExpiry > now.getTime()) return null;
    const updated: ToolInvocationRecord = {
      ...record,
      updatedAt: now.toISOString(),
      metadata: {
        ...record.metadata,
        cancelDeliveryClaimId: claimId,
        cancelDeliveryClaimExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      },
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async markCancelDeliveryAttempt(
    invocationId: string,
    metadataPatch: Record<string, unknown> = {},
    claimId?: string,
  ): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record || (claimId && record.metadata.cancelDeliveryClaimId !== claimId)) return null;
    const metadata = { ...record.metadata, ...metadataPatch };
    delete metadata.cancelDeliveryClaimId;
    delete metadata.cancelDeliveryClaimExpiresAt;
    const updated: ToolInvocationRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      metadata,
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async markCancelDelivered(
    invocationId: string,
    metadataPatch: Record<string, unknown> = {},
    claimId?: string,
  ): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record || (claimId && record.metadata.cancelDeliveryClaimId !== claimId)) return null;
    const metadata = { ...record.metadata, ...metadataPatch };
    delete metadata.cancelDeliveryClaimId;
    delete metadata.cancelDeliveryClaimExpiresAt;
    const updated: ToolInvocationRecord = {
      ...record,
      cancelDeliveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata,
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async get(invocationId: string): Promise<ToolInvocationRecord | null> {
    return this.invocations.get(invocationId) ?? null;
  }

  async listRunning(sessionId?: string): Promise<ToolInvocationRecord[]> {
    return [...this.invocations.values()]
      .filter((record) => record.status === 'running')
      .filter((record) => !sessionId || record.sessionId === sessionId);
  }

  async listCancelRequested(sessionId?: string): Promise<ToolInvocationRecord[]> {
    return [...this.invocations.values()]
      .filter((record) => record.cancelRequestedAt && !record.cancelDeliveredAt)
      .filter((record) => !sessionId || record.sessionId === sessionId);
  }

  async listCancelRecoveryCandidates(): Promise<ToolInvocationRecord[]> {
    // In-memory store 不持有 run 状态；恢复器会通过 RunStore 再做 cancelled 过滤。
    return [...this.invocations.values()].filter((record) => !record.cancelRequestedAt);
  }
}

export interface PgToolInvocationStoreOptions {
  pool: import('pg').Pool;
  tablePrefix?: string;
}

export class PgToolInvocationStore implements ToolInvocationStore {
  readonly toolInvocationsTable: string;
  readonly sessionsTable: string;
  readonly runsTable: string;

  constructor(private readonly options: PgToolInvocationStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.toolInvocationsTable = `${prefix}_tool_invocations`;
    this.sessionsTable = `${prefix}_sessions`;
    this.runsTable = `${prefix}_runs`;
  }

  async init(): Promise<void> {
    await this.options.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.toolInvocationsTable} (
        invocation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        execution_target TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        cancel_requested_at TIMESTAMPTZ,
        cancel_reason TEXT,
        cancel_delivered_at TIMESTAMPTZ,
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.options.pool.query(`ALTER TABLE ${this.toolInvocationsTable} ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ`);
    await this.options.pool.query(`ALTER TABLE ${this.toolInvocationsTable} ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
    await this.options.pool.query(`ALTER TABLE ${this.toolInvocationsTable} ADD COLUMN IF NOT EXISTS cancel_delivered_at TIMESTAMPTZ`);
    // PR 3：多组织改造 — 加 tenant_id 列。旧 invocation 回填 LEGACY_TENANT_ID；
    // 新 invocation 由调用方传入或走平台根 fallback。
    await this.options.pool.query(`ALTER TABLE ${this.toolInvocationsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_session_idx ON ${this.toolInvocationsTable} (session_id)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_run_idx ON ${this.toolInvocationsTable} (run_id)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_status_idx ON ${this.toolInvocationsTable} (status)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_tenant_idx ON ${this.toolInvocationsTable} (tenant_id, started_at DESC)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_tool_name_idx ON ${this.toolInvocationsTable} (tool_name, started_at DESC)`);
  }

  async start(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      // 与 run 终态 UPDATE 锁同一行：start 先拿锁时，终态提交随后能看到 invocation；
      // 终态先拿锁时，start 原子落为不可执行记录。只有 cancelled 需要 durable cancel outbox。
      const run = await client.query<{ status: string }>(`
        SELECT status FROM ${this.runsTable} WHERE run_id = $1 FOR SHARE
      `, [input.runId]);
      if (!run.rows[0]) throw new Error(`Cannot start tool invocation for missing run ${input.runId}`);
      const runStatus = run.rows[0].status;
      const terminalRunStatus = ['completed', 'failed', 'cancelled', 'orphaned'].includes(runStatus)
        ? runStatus
        : null;
      const runAlreadyCancelled = terminalRunStatus === 'cancelled';
      const now = new Date().toISOString();
      const cancelReason = runAlreadyCancelled ? 'run_already_cancelled_before_tool_start' : null;
      const terminalError = terminalRunStatus && !runAlreadyCancelled
        ? `run_already_terminal_before_tool_start status=${terminalRunStatus}`
        : null;
      const metadata = {
        ...(input.metadata ?? {}),
        ...(terminalRunStatus ? { terminalRunStatus } : {}),
        ...(runAlreadyCancelled ? { cancelRecovery: 'late_start' } : {}),
      };
      const result = await client.query<ToolInvocationRow>(`
        INSERT INTO ${this.toolInvocationsTable}
          (invocation_id, run_id, session_id, tool_call_id, tool_name, execution_target, tenant_id,
           status, started_at, updated_at, completed_at, cancel_requested_at, cancel_reason, error, metadata)
        VALUES (
          $1, $2, $3, $4, $5, $6, COALESCE($7, '${DEFAULT_TENANT_ID}'),
          CASE
            WHEN $10::text = 'cancelled' THEN 'cancelled'
            WHEN $10::text IS NOT NULL THEN 'failed'
            ELSE 'running'
          END,
          $8, $8,
          CASE WHEN $10::text IS NOT NULL THEN $8::timestamptz ELSE NULL END,
          CASE WHEN $10::text = 'cancelled' THEN $8::timestamptz ELSE NULL END,
          $11,
          $12,
          $9::jsonb
        )
        ON CONFLICT (invocation_id) DO UPDATE SET
          updated_at = EXCLUDED.updated_at,
          tenant_id = CASE WHEN $7 IS NULL THEN ${this.toolInvocationsTable}.tenant_id ELSE EXCLUDED.tenant_id END,
          status = CASE
            WHEN EXCLUDED.status <> 'running' AND ${this.toolInvocationsTable}.status = 'running' THEN EXCLUDED.status
            ELSE ${this.toolInvocationsTable}.status
          END,
          completed_at = CASE
            WHEN EXCLUDED.status <> 'running' AND ${this.toolInvocationsTable}.status = 'running'
              THEN COALESCE(${this.toolInvocationsTable}.completed_at, EXCLUDED.completed_at)
            ELSE ${this.toolInvocationsTable}.completed_at
          END,
          cancel_requested_at = CASE
            WHEN EXCLUDED.status = 'cancelled' AND ${this.toolInvocationsTable}.status = 'running'
              THEN COALESCE(${this.toolInvocationsTable}.cancel_requested_at, EXCLUDED.cancel_requested_at)
            ELSE ${this.toolInvocationsTable}.cancel_requested_at
          END,
          cancel_reason = CASE
            WHEN EXCLUDED.status = 'cancelled' AND ${this.toolInvocationsTable}.status = 'running'
              THEN COALESCE(${this.toolInvocationsTable}.cancel_reason, EXCLUDED.cancel_reason)
            ELSE ${this.toolInvocationsTable}.cancel_reason
          END,
          error = CASE
            WHEN EXCLUDED.status = 'failed' AND ${this.toolInvocationsTable}.status = 'running'
              THEN COALESCE(${this.toolInvocationsTable}.error, EXCLUDED.error)
            ELSE ${this.toolInvocationsTable}.error
          END,
          metadata = ${this.toolInvocationsTable}.metadata || CASE
            WHEN ${this.toolInvocationsTable}.status = 'running' THEN EXCLUDED.metadata
            ELSE EXCLUDED.metadata - 'cancelRecovery' - 'terminalRunStatus'
          END
        RETURNING *
      `, [
        input.invocationId,
        input.runId,
        input.sessionId,
        input.toolCallId,
        input.toolName,
        input.executionTarget,
        input.tenantId ?? null,
        now,
        JSON.stringify(metadata),
        terminalRunStatus,
        cancelReason,
        terminalError,
      ]);
      await client.query('COMMIT');
      return rowToRecord(result.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async invokeWithActiveRunGate<T>(
    runId: string,
    invocationId: string,
    invoke: () => Promise<T>,
    _readRunStatus?: () => Promise<string | null>,
  ): Promise<ToolInvocationRunGateResult<T>> {
    return invokeWithPgActiveRunGate<T, ToolInvocationRow>({
      pool: this.options.pool,
      runsTable: this.runsTable,
      toolInvocationsTable: this.toolInvocationsTable,
      rowToRecord,
    }, runId, invocationId, invoke);
  }

  async complete(invocationId: string, status: Exclude<ToolInvocationStatus, 'running'>, error?: string): Promise<ToolInvocationRecord | null> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const invocation = await client.query<{ run_id: string }>(`
        SELECT run_id FROM ${this.toolInvocationsTable} WHERE invocation_id = $1
      `, [invocationId]);
      if (!invocation.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      // 与 stop 保持 run → invocation 锁序。complete 先锁到 run 时，它在线性化点前完成；
      // stop 先锁到 run 时，complete 会原子补 durable cancel outbox 后再终态化。
      const run = await client.query<{ status: string }>(`
        SELECT status FROM ${this.runsTable} WHERE run_id = $1 FOR SHARE
      `, [invocation.rows[0].run_id]);
      if (!run.rows[0]) throw new Error(`Cannot complete tool invocation for missing run ${invocation.rows[0].run_id}`);
      const runAlreadyCancelled = run.rows[0].status === 'cancelled';
      const result = await client.query<ToolInvocationRow>(`
        UPDATE ${this.toolInvocationsTable}
        SET status = $2,
            updated_at = clock_timestamp(),
            completed_at = clock_timestamp(),
            error = $3,
            cancel_requested_at = CASE
              WHEN $4::boolean THEN COALESCE(cancel_requested_at, clock_timestamp())
              ELSE cancel_requested_at
            END,
            cancel_reason = CASE
              WHEN $4::boolean THEN COALESCE(cancel_reason, 'run_cancelled_before_tool_completion')
              ELSE cancel_reason
            END,
            metadata = metadata || CASE
              WHEN $4::boolean THEN '{"cancelRecovery":"complete_after_cancelled_run"}'::jsonb
              ELSE '{}'::jsonb
            END
        WHERE invocation_id = $1 AND status = 'running'
        RETURNING *
      `, [invocationId, status, error ?? null, runAlreadyCancelled]);
      await client.query('COMMIT');
      return result.rows[0] ? rowToRecord(result.rows[0]) : null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async requestCancel(invocationId: string, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.toolInvocationsTable}
      SET cancel_requested_at = COALESCE(cancel_requested_at, $2),
          cancel_reason = COALESCE(cancel_reason, $3),
          updated_at = $2,
          metadata = metadata || $4::jsonb
      WHERE invocation_id = $1
      RETURNING *
    `, [invocationId, now, reason ?? null, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async requestCancelOnce(
    invocationId: string,
    reason?: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<{ record: ToolInvocationRecord; created: boolean } | null> {
    const now = new Date().toISOString();
    const created = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.toolInvocationsTable}
      SET cancel_requested_at = $2,
          cancel_reason = COALESCE(cancel_reason, $3),
          updated_at = $2,
          metadata = metadata || $4::jsonb
      WHERE invocation_id = $1
        AND cancel_requested_at IS NULL
      RETURNING *
    `, [invocationId, now, reason ?? null, JSON.stringify(metadataPatch)]);
    if (created.rows[0]) return { record: rowToRecord(created.rows[0]), created: true };
    const existing = await this.options.pool.query<ToolInvocationRow>(`
      SELECT * FROM ${this.toolInvocationsTable}
      WHERE invocation_id = $1 AND cancel_requested_at IS NOT NULL
    `, [invocationId]);
    return existing.rows[0] ? { record: rowToRecord(existing.rows[0]), created: false } : null;
  }

  async requestCancelOnceAfterRunCancellation(
    invocationId: string,
    _runCancelledAt: string,
    reason?: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<{ record: ToolInvocationRecord; created: boolean } | null> {
    const now = new Date().toISOString();
    const created = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.toolInvocationsTable} invocation
      SET cancel_requested_at = $2::timestamptz,
          cancel_reason = COALESCE(invocation.cancel_reason, $3),
          updated_at = $2::timestamptz,
          metadata = invocation.metadata || $4::jsonb
      FROM ${this.runsTable} run
      WHERE invocation.invocation_id = $1
        AND run.run_id = invocation.run_id
        AND run.status = 'cancelled'
        AND run.cancelled_at IS NOT NULL
        AND invocation.cancel_requested_at IS NULL
        AND (
          invocation.status = 'running'
          OR (invocation.completed_at IS NOT NULL AND invocation.completed_at >= run.cancelled_at)
        )
      RETURNING invocation.*
    `, [invocationId, now, reason ?? null, JSON.stringify(metadataPatch)]);
    if (created.rows[0]) return { record: rowToRecord(created.rows[0]), created: true };
    const existing = await this.options.pool.query<ToolInvocationRow>(`
      SELECT * FROM ${this.toolInvocationsTable}
      WHERE invocation_id = $1 AND cancel_requested_at IS NOT NULL
    `, [invocationId]);
    return existing.rows[0] ? { record: rowToRecord(existing.rows[0]), created: false } : null;
  }

  async claimCancelDelivery(
    invocationId: string,
    claimId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<ToolInvocationRecord | null> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.toolInvocationsTable}
      SET updated_at = $3::timestamptz,
          metadata = metadata || jsonb_build_object(
            'cancelDeliveryClaimId', $2::text,
            'cancelDeliveryClaimExpiresAt', $4::text
          )
      WHERE invocation_id = $1
        AND cancel_requested_at IS NOT NULL
        AND cancel_delivered_at IS NULL
        AND (
          metadata->>'cancelDeliveryNextAttemptAt' IS NULL
          OR (metadata->>'cancelDeliveryNextAttemptAt')::timestamptz <= $3::timestamptz
        )
        AND (
          metadata->>'cancelDeliveryClaimExpiresAt' IS NULL
          OR (metadata->>'cancelDeliveryClaimExpiresAt')::timestamptz <= $3::timestamptz
        )
      RETURNING *
    `, [invocationId, claimId, now.toISOString(), leaseExpiresAt]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async markCancelDeliveryAttempt(
    invocationId: string,
    metadataPatch: Record<string, unknown> = {},
    claimId?: string,
  ): Promise<ToolInvocationRecord | null> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.toolInvocationsTable}
      SET updated_at = $2,
          metadata = (metadata - 'cancelDeliveryClaimId' - 'cancelDeliveryClaimExpiresAt') || $3::jsonb
      WHERE invocation_id = $1
        AND ($4::text IS NULL OR metadata->>'cancelDeliveryClaimId' = $4)
      RETURNING *
    `, [invocationId, now, JSON.stringify(metadataPatch), claimId ?? null]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async markCancelDelivered(
    invocationId: string,
    metadataPatch: Record<string, unknown> = {},
    claimId?: string,
  ): Promise<ToolInvocationRecord | null> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.toolInvocationsTable}
      SET cancel_delivered_at = COALESCE(cancel_delivered_at, $2),
          updated_at = $2,
          metadata = (metadata - 'cancelDeliveryClaimId' - 'cancelDeliveryClaimExpiresAt') || $3::jsonb
      WHERE invocation_id = $1
        AND ($4::text IS NULL OR metadata->>'cancelDeliveryClaimId' = $4)
      RETURNING *
    `, [invocationId, now, JSON.stringify(metadataPatch), claimId ?? null]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async get(invocationId: string): Promise<ToolInvocationRecord | null> {
    const result = await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE invocation_id = $1`, [invocationId]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async listRunning(sessionId?: string): Promise<ToolInvocationRecord[]> {
    const result = sessionId
      ? await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE status = 'running' AND session_id = $1 ORDER BY started_at ASC`, [sessionId])
      : await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE status = 'running' ORDER BY started_at ASC`);
    return result.rows.map(rowToRecord);
  }

  async listCancelRequested(sessionId?: string): Promise<ToolInvocationRecord[]> {
    const result = sessionId
      ? await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE cancel_requested_at IS NOT NULL AND cancel_delivered_at IS NULL AND session_id = $1 ORDER BY cancel_requested_at ASC`, [sessionId])
      : await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE cancel_requested_at IS NOT NULL AND cancel_delivered_at IS NULL ORDER BY cancel_requested_at ASC`);
    return result.rows.map(rowToRecord);
  }

  async listCancelRecoveryCandidates(): Promise<ToolInvocationRecord[]> {
    const result = await this.options.pool.query<ToolInvocationRow>(`
      SELECT invocation.*
      FROM ${this.toolInvocationsTable} invocation
      INNER JOIN ${this.runsTable} run ON run.run_id = invocation.run_id
      WHERE run.status = 'cancelled'
        AND invocation.cancel_requested_at IS NULL
        AND (
          invocation.status = 'running'
          OR (
            invocation.completed_at IS NOT NULL
            AND run.cancelled_at IS NOT NULL
            AND invocation.completed_at >= run.cancelled_at
          )
        )
      ORDER BY invocation.started_at ASC
    `);
    return result.rows.map(rowToRecord);
  }

  async deleteByTenant(tenantId: string): Promise<number> {
    const result = await this.options.pool.query(`DELETE FROM ${this.toolInvocationsTable} WHERE tenant_id = $1`, [tenantId]);
    return result.rowCount ?? 0;
  }

  async listForAdmin(query: AdminToolInvocationQuery = {}): Promise<AdminToolInvocationResult> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      clauses.push(clause.replace('?', `$${params.length}`));
    };
    add('t.started_at >= now() - make_interval(hours => ?::int)', query.hours ?? 168);
    if (query.tenantId) add('t.tenant_id = ?', query.tenantId);
    if (query.userId) add('s.user_id = ?', query.userId);
    if (query.toolName) add('lower(t.tool_name) = lower(?)', query.toolName);
    if (query.skillName) add("lower(NULLIF(t.metadata->>'skillName', '')) = lower(?)", query.skillName);
    if (query.status) add('t.status = ?', query.status);
    if (query.reasonContains) add("COALESCE(t.error, '') ILIKE '%' || ? || '%'", query.reasonContains);
    const where = clauses.join(' AND ');
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);
    const pageParams = [...params, limit, offset];

    const [itemsResult, summaryResult, byToolResult, bySkillResult] = await Promise.all([
      this.options.pool.query<AdminToolInvocationRow>(`
        SELECT t.invocation_id, t.run_id, t.session_id, t.tenant_id,
               s.user_id, s.username, t.tool_name,
               NULLIF(t.metadata->>'skillName', '') AS skill_name,
               t.execution_target, t.status, t.started_at, t.completed_at,
               CASE WHEN t.completed_at IS NULL THEN NULL
                    ELSE GREATEST(0, EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) * 1000)
               END AS duration_ms,
               t.error
        FROM ${this.toolInvocationsTable} t
        LEFT JOIN ${this.sessionsTable} s ON s.session_id = t.session_id
        WHERE ${where}
        ORDER BY t.started_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, pageParams),
      this.options.pool.query<AdminToolInvocationSummaryRow>(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE t.status IN ('failed', 'cancelled'))::int AS failed,
               count(DISTINCT t.tenant_id)::int AS affected_tenants,
               count(DISTINCT s.user_id) FILTER (WHERE s.user_id IS NOT NULL)::int AS affected_users,
               count(*) FILTER (WHERE lower(t.tool_name) = 'skill')::int AS skill_calls,
               count(*) FILTER (
                 WHERE lower(t.tool_name) = 'skill' AND NULLIF(t.metadata->>'skillName', '') IS NOT NULL
               )::int AS skill_calls_tracked
        FROM ${this.toolInvocationsTable} t
        LEFT JOIN ${this.sessionsTable} s ON s.session_id = t.session_id
        WHERE ${where}
      `, params),
      this.options.pool.query<AdminToolInvocationByToolRow>(`
        SELECT t.tool_name,
               count(*)::int AS count,
               count(*) FILTER (WHERE t.status IN ('failed', 'cancelled'))::int AS failed,
               avg(EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) * 1000)
                 FILTER (WHERE t.completed_at IS NOT NULL) AS avg_duration_ms,
               max(t.started_at) AS last_called_at
        FROM ${this.toolInvocationsTable} t
        LEFT JOIN ${this.sessionsTable} s ON s.session_id = t.session_id
        WHERE ${where}
        GROUP BY t.tool_name
        ORDER BY count DESC, t.tool_name ASC
        LIMIT 100
      `, params),
      this.options.pool.query<AdminToolInvocationBySkillRow>(`
        SELECT NULLIF(t.metadata->>'skillName', '') AS skill_name,
               count(*)::int AS count,
               count(*) FILTER (WHERE t.status IN ('failed', 'cancelled'))::int AS failed,
               count(DISTINCT t.tenant_id)::int AS affected_tenants,
               count(DISTINCT s.user_id) FILTER (WHERE s.user_id IS NOT NULL)::int AS affected_users,
               max(t.started_at) AS last_called_at
        FROM ${this.toolInvocationsTable} t
        LEFT JOIN ${this.sessionsTable} s ON s.session_id = t.session_id
        WHERE ${where} AND NULLIF(t.metadata->>'skillName', '') IS NOT NULL
        GROUP BY skill_name
        ORDER BY count DESC, skill_name ASC
        LIMIT 100
      `, params),
    ]);
    const summary = summaryResult.rows[0];
    return {
      items: itemsResult.rows.map(rowToAdminEntry),
      summary: {
        total: summary?.total ?? 0,
        failed: summary?.failed ?? 0,
        affectedTenants: summary?.affected_tenants ?? 0,
        affectedUsers: summary?.affected_users ?? 0,
        skillCalls: summary?.skill_calls ?? 0,
        skillCallsTracked: summary?.skill_calls_tracked ?? 0,
      },
      byTool: byToolResult.rows.map((row) => ({
        toolName: row.tool_name,
        count: row.count,
        failed: row.failed,
        avgDurationMs: nullableNumber(row.avg_duration_ms),
        lastCalledAt: toIso(row.last_called_at),
      })),
      bySkill: bySkillResult.rows.map((row) => ({
        skillName: row.skill_name,
        count: row.count,
        failed: row.failed,
        affectedTenants: row.affected_tenants,
        affectedUsers: row.affected_users,
        lastCalledAt: toIso(row.last_called_at),
      })),
    };
  }
}

interface AdminToolInvocationRow {
  invocation_id: string;
  run_id: string;
  session_id: string;
  tenant_id: string;
  user_id: string | null;
  username: string | null;
  tool_name: string;
  skill_name: string | null;
  execution_target: ExecutionTargetKind;
  status: ToolInvocationStatus;
  started_at: Date | string;
  completed_at: Date | string | null;
  duration_ms: string | number | null;
  error: string | null;
}

interface AdminToolInvocationSummaryRow {
  total: number;
  failed: number;
  affected_tenants: number;
  affected_users: number;
  skill_calls: number;
  skill_calls_tracked: number;
}

interface AdminToolInvocationByToolRow {
  tool_name: string;
  count: number;
  failed: number;
  avg_duration_ms: string | number | null;
  last_called_at: Date | string;
}

interface AdminToolInvocationBySkillRow {
  skill_name: string;
  count: number;
  failed: number;
  affected_tenants: number;
  affected_users: number;
  last_called_at: Date | string;
}

interface ToolInvocationRow {
  invocation_id: string;
  run_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  execution_target: ExecutionTargetKind;
  tenant_id: string | null;
  status: ToolInvocationStatus;
  started_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  cancel_requested_at: Date | string | null;
  cancel_reason: string | null;
  cancel_delivered_at: Date | string | null;
  error: string | null;
  metadata: Record<string, unknown> | string;
}

function rowToRecord(row: ToolInvocationRow): ToolInvocationRecord {
  return {
    invocationId: row.invocation_id,
    runId: row.run_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    executionTarget: row.execution_target,
    tenantId: row.tenant_id ?? undefined,
    status: row.status,
    startedAt: toIso(row.started_at),
    updatedAt: toIso(row.updated_at),
    ...(row.completed_at ? { completedAt: toIso(row.completed_at) } : {}),
    ...(row.cancel_requested_at ? { cancelRequestedAt: toIso(row.cancel_requested_at) } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.cancel_delivered_at ? { cancelDeliveredAt: toIso(row.cancel_delivered_at) } : {}),
    ...(row.error ? { error: row.error } : {}),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) as Record<string, unknown> : row.metadata,
  };
}

function rowToAdminEntry(row: AdminToolInvocationRow): AdminToolInvocationEntry {
  return {
    invocationId: row.invocation_id,
    runId: row.run_id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    username: row.username,
    toolName: row.tool_name,
    skillName: row.skill_name,
    executionTarget: row.execution_target,
    status: row.status,
    startedAt: toIso(row.started_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    durationMs: nullableNumber(row.duration_ms),
    error: row.error,
  };
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
