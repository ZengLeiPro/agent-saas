import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { allocatePgEventSequences } from './pgEventCursorAllocator.js';
import { encodePgEventNotifyPayload, lockPgEventGlobalSequence } from './pgEventStoreProtocol.js';
import type { PlatformEvent, PlatformEventInput } from './types.js';
import { buildRunCancellationEvents } from './runCancellationEvents.js';
import { releaseRunLease } from './runTerminalLifecycle.js';
import { ACTIVE_STEERING_TARGET_STATUSES, STEERING_TARGET_STATUS_SQL, STOPPABLE_RUN_STATUS_SQL } from './runStatusPolicy.js';
import { normalizeRunRecord, parseCount, sanitizeIdentifier, serializeRuntimeEvent, stringMetadata } from './runStoreRecordHelpers.js';
import { PgRunStoreQueries } from './runStoreQueries.js';
import { hasTaskboardSessionActivity } from './runStoreSessionActivity.js';
import { buildAppliedSteeringEventInputs, selectSteeringEventCandidates } from './steeringRuntimeEvents.js';
const { Pool } = pg;
type PgPoolClient = pg.PoolClient;
export * from './runStoreTypes.js';
import { BackgroundTaskLimitError, RunCreateConflictError } from './runStoreTypes.js';
import type { ActiveRunCounts, CancelSteeringResult, EnqueueBackgroundTaskLimits, LatestResponseSessionState, ListBackgroundTasksOptions, MessageDeliveryMode, PgPool, PgRunStoreOptions, ResponseSessionStatePatch, RunLeaseAdmission, RunRecord, RunStatus, RunStore, SteeringApplyInput, SteeringApplyResult, SteeringInputRecord, UpsertRunInput } from './runStoreTypes.js';
export class PgRunStore implements RunStore {
  readonly pool: PgPool;
  readonly runsTable: string;
  readonly messageSubmissionsTable: string;
  readonly steeringInputsTable: string;
  readonly steeringSessionsTable: string;
  readonly eventsTable: string;
  readonly eventCursorsTable: string;
  readonly toolInvocationsTable: string;
  readonly eventNotifyChannel: string;
  private readonly ownsPool: boolean;
  private readonly queries: PgRunStoreQueries;

  constructor(options: PgRunStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgRunStore requires either pool or connectionString');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.runsTable = `${prefix}_runs`;
    this.messageSubmissionsTable = `${prefix}_message_submissions`;
    this.steeringInputsTable = `${prefix}_steering_inputs`;
    this.steeringSessionsTable = `${prefix}_steering_sessions`;
    this.eventsTable = `${prefix}_events`;
    this.eventCursorsTable = `${prefix}_event_cursors`;
    this.toolInvocationsTable = `${prefix}_tool_invocations`;
    this.eventNotifyChannel = `${prefix}_events_notify`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
    this.queries = new PgRunStoreQueries(this.pool, this.runsTable, this.messageSubmissionsTable, this.steeringInputsTable);
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
          enqueue_seq BIGSERIAL NOT NULL,
          session_id TEXT NOT NULL,
          user_id TEXT,
          submitter_scope TEXT,
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.messageSubmissionsTable} (
          user_scope TEXT NOT NULL,
          client_message_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          delivery_mode TEXT NOT NULL,
          accepted_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (user_scope, client_message_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.steeringInputsTable} (
          input_id TEXT PRIMARY KEY,
          source_run_id TEXT NOT NULL UNIQUE,
          target_run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          sequence BIGSERIAL NOT NULL,
          accepted_at TIMESTAMPTZ NOT NULL,
          reserved_at TIMESTAMPTZ,
          applied_at TIMESTAMPTZ
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.steeringSessionsTable} (
          session_id TEXT PRIMARY KEY,
          stopped_at TIMESTAMPTZ
        )
      `);
      await client.query(`ALTER TABLE ${this.steeringInputsTable} ADD COLUMN IF NOT EXISTS sequence BIGSERIAL`);
      await client.query(`ALTER TABLE ${this.steeringInputsTable} ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.steeringInputsTable}_target_sequence_idx ON ${this.steeringInputsTable} (target_run_id, state, sequence)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.steeringInputsTable}_source_idx ON ${this.steeringInputsTable} (source_run_id, state)`);
      const existingColumns = new Set((await client.query<{ column_name: string }>(`
        SELECT attname AS column_name
        FROM pg_attribute
        WHERE attrelid = $1::regclass
          AND attnum > 0
          AND NOT attisdropped
      `, [this.runsTable])).rows.map((row) => row.column_name));
      // 严格 FIFO 使用数据库分配的单调序号，避免同毫秒 client runId 的随机后缀打乱顺序。
      if (!existingColumns.has('enqueue_seq')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN enqueue_seq BIGSERIAL`);
        // BIGSERIAL 的默认回填取决于物理扫描顺序；按历史 requested_at 重排后再推进 sequence。
        await client.query(`
          WITH ordered AS (
            SELECT run_id, ROW_NUMBER() OVER (ORDER BY requested_at ASC, run_id ASC) AS seq
            FROM ${this.runsTable}
          )
          UPDATE ${this.runsTable} run
          SET enqueue_seq = ordered.seq
          FROM ordered
          WHERE run.run_id = ordered.run_id
        `);
        await client.query(`
          SELECT setval(
            pg_get_serial_sequence('${this.runsTable}', 'enqueue_seq'),
            COALESCE((SELECT MAX(enqueue_seq) FROM ${this.runsTable}), 1),
            EXISTS (SELECT 1 FROM ${this.runsTable})
          )
        `);
        await client.query(`ALTER TABLE ${this.runsTable} ALTER COLUMN enqueue_seq SET NOT NULL`);
      }
      // RFC v1 P0.4：Responses API session state 字段。先查 catalog 再按缺口 ALTER，
      // 避免每次启动为已存在的列申请强表锁。
      if (!existingColumns.has('last_response_id')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN last_response_id TEXT`);
      }
      if (!existingColumns.has('last_response_expire_at')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN last_response_expire_at TIMESTAMPTZ`);
      }
      if (!existingColumns.has('actual_model_seen')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN actual_model_seen TEXT`);
      }
      // 2026-07-02：接力身份键（切模型后跨后端接力必炸，见 findLatestResponseSessionStateBySession 调用方）
      if (!existingColumns.has('last_response_model')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN last_response_model TEXT`);
      }
      if (!existingColumns.has('last_response_profile_digest')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN last_response_profile_digest TEXT`);
      }
      if (!existingColumns.has('cumulative_input_tokens')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN cumulative_input_tokens BIGINT NOT NULL DEFAULT 0`);
      }
      if (!existingColumns.has('sandbox_scope_id')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN sandbox_scope_id TEXT`);
      }
      // PR 3：多组织改造 — 加 tenant_id 列，旧数据回填 LEGACY_TENANT_ID，新 run 由
      // dispatch 层（PR 4）显式传入；UpsertRunInput 已加可选 tenantId 字段。
      if (!existingColumns.has('tenant_id')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
      }
      if (!existingColumns.has('submitter_scope')) {
        await client.query(`ALTER TABLE ${this.runsTable} ADD COLUMN submitter_scope TEXT`);
      }
      await client.query(`UPDATE ${this.runsTable} SET sandbox_scope_id = metadata->>'sandboxScopeId' WHERE sandbox_scope_id IS NULL AND metadata ? 'sandboxScopeId'`);
      // wakeMessage 是活跃 Run 的 durable 恢复载荷；Run 进入终态后已无恢复用途，启动时清理历史遗留正文。
      await client.query(`UPDATE ${this.runsTable} SET metadata = metadata - 'wakeMessage' WHERE status IN ('completed','failed','cancelled','orphaned') AND metadata ? 'wakeMessage'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_tenant_idx ON ${this.runsTable} (tenant_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_user_idx ON ${this.runsTable} (user_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_sandbox_scope_idx ON ${this.runsTable} (sandbox_scope_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_status_idx ON ${this.runsTable} (status, updated_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_session_idx ON ${this.runsTable} (session_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_session_enqueue_idx ON ${this.runsTable} (session_id, enqueue_seq)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_background_parent_session_idx ON ${this.runsTable} ((metadata->>'parentSessionId'), requested_at DESC) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_background_top_session_idx ON ${this.runsTable} ((metadata->>'topLevelSessionId'), requested_at DESC) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_background_parent_run_idx ON ${this.runsTable} ((metadata->>'parentRunId'), status) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_background_tenant_status_idx ON ${this.runsTable} (tenant_id, status, updated_at) WHERE metadata->>'backgroundTask' = 'true'`);
      // RFC v1 P0.4：按 sessionId 找最近完成 run 的 last_response_id（跨 run 接力查询路径）
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_session_last_response_idx ON ${this.runsTable} (session_id, updated_at DESC) WHERE last_response_id IS NOT NULL`);
      await client.query(`DROP INDEX IF EXISTS ${this.runsTable}_active_idempotency_idx`);
      await client.query(`DROP INDEX IF EXISTS ${this.runsTable}_active_idempotency_v2_idx`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.runsTable}_active_idempotency_v3_idx ON ${this.runsTable} ((COALESCE(submitter_scope, user_id, '__anonymous__')), idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')`);
      await client.query(`DROP INDEX IF EXISTS ${this.runsTable}_idempotency_lookup_idx`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_idempotency_lookup_v2_idx ON ${this.runsTable} ((COALESCE(submitter_scope, user_id, '__anonymous__')), idempotency_key, updated_at DESC) WHERE idempotency_key IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.messageSubmissionsTable}_session_idx ON ${this.messageSubmissionsTable} (session_id, accepted_at)`);
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
        (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at, idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata)
      VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb)
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
        sandbox_scope_id = COALESCE(EXCLUDED.sandbox_scope_id, ${this.runsTable}.sandbox_scope_id),
        submitter_scope = COALESCE(EXCLUDED.submitter_scope, ${this.runsTable}.submitter_scope),
        metadata = ${this.runsTable}.metadata || EXCLUDED.metadata
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [input.runId, input.sessionId, input.userId ?? null, input.tenantId ?? null, input.model ?? null, input.channel ?? null, now, input.idempotencyKey ?? null, input.executionTarget ?? null, input.workspaceId ?? null, input.sandboxScopeId ?? null, input.submitterUserId ?? input.userId ?? null, JSON.stringify(input.metadata ?? {})]);
    return normalizeRunRecord(result.rows[0]!.row_json);
  }
  async createPending(input: UpsertRunInput): Promise<{ record: RunRecord; created: boolean }> {
    const now = new Date().toISOString();
    let result: { rows: Array<{ row_json: RunRecord }> };
    try {
      result = await this.pool.query<{ row_json: RunRecord }>(`
        INSERT INTO ${this.runsTable}
          (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at, idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata)
        VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (run_id) DO NOTHING
        RETURNING row_to_json(${this.runsTable}.*) AS row_json
      `, [input.runId, input.sessionId, input.userId ?? null, input.tenantId ?? null, input.model ?? null, input.channel ?? null, now, input.idempotencyKey ?? null, input.executionTarget ?? null, input.workspaceId ?? null, input.sandboxScopeId ?? null, input.submitterUserId ?? input.userId ?? null, JSON.stringify(input.metadata ?? {})]);
    } catch (error) {
      if ((error as { code?: unknown }).code === '23505') {
        throw new RunCreateConflictError(`Run create-only idempotency conflict: ${input.runId}`);
      }
      throw error;
    }
    if (result.rows[0]) {
      return { record: normalizeRunRecord(result.rows[0].row_json), created: true };
    }
    const existing = await this.get(input.runId);
    if (!existing) throw new Error(`Run create-only conflict disappeared: ${input.runId}`);
    return { record: existing, created: false };
  }
  async enqueueSteeringAware(input: UpsertRunInput): Promise<RunRecord> {
    return this.enqueueUserMessage({ ...input, idempotencyKey: input.idempotencyKey ?? input.runId }, 'steer');
  }

  async enqueueUserMessage(input: UpsertRunInput, deliveryMode: MessageDeliveryMode): Promise<RunRecord> {
    if (!input.idempotencyKey) throw new Error('User message enqueue requires idempotencyKey');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${this.runsTable}:message:${input.sessionId}`,
      ]);
      const now = new Date().toISOString();
      const userScope = input.submitterUserId ?? input.userId ?? '__anonymous__';
      const submission = await client.query<{ run_id: string }>(`
        INSERT INTO ${this.messageSubmissionsTable}
          (user_scope, client_message_id, run_id, session_id, delivery_mode, accepted_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (user_scope, client_message_id) DO NOTHING
        RETURNING run_id
      `, [userScope, input.idempotencyKey, input.runId, input.sessionId, deliveryMode, now]);
      if (!submission.rows[0]) {
        const existingSubmission = await client.query<{ run_id: string }>(`
          SELECT run_id
          FROM ${this.messageSubmissionsTable}
          WHERE user_scope = $1 AND client_message_id = $2
        `, [userScope, input.idempotencyKey]);
        const existingRunId = existingSubmission.rows[0]?.run_id;
        const existing = existingRunId
          ? await client.query<{ row_json: RunRecord }>(`
            SELECT row_to_json(${this.runsTable}.*) AS row_json
            FROM ${this.runsTable}
            WHERE run_id = $1
          `, [existingRunId])
          : { rows: [] };
        if (!existing.rows[0]) throw new Error('Message submission exists without run');
        await client.query('COMMIT');
        return normalizeRunRecord(existing.rows[0].row_json);
      }

      const acceptedAt = typeof input.metadata?.steeringAcceptedAt === 'string'
        ? input.metadata.steeringAcceptedAt
        : undefined;
      if (deliveryMode === 'steer' && acceptedAt) {
        const stop = await client.query<{ stopped_at: string | Date | null }>(`
          SELECT stopped_at
          FROM ${this.steeringSessionsTable}
          WHERE session_id = $1
        `, [input.sessionId]);
        const stoppedAt = stop.rows[0]?.stopped_at;
        if (stoppedAt && Date.parse(acceptedAt) <= new Date(stoppedAt).getTime()) {
          throw new Error('chat was accepted before the latest session stop');
        }
      }

      let targetRunId: string | undefined;
      let queuedBehindRunId: string | undefined;
      if (deliveryMode === 'steer') {
        const targetResult = await client.query<{ run_id: string }>(`
          SELECT target.run_id
          FROM ${this.runsTable} target
          WHERE target.session_id = $1
            AND target.run_id <> $2
            AND target.status IN ${STEERING_TARGET_STATUS_SQL}
            AND target.channel = 'web'
            AND target.model IS NOT DISTINCT FROM $3::text
            AND target.execution_target IS NOT DISTINCT FROM $4::text
            AND target.workspace_id IS NOT DISTINCT FROM $5::text
            AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open'
            AND COALESCE(target.metadata->>'backgroundTask', 'false') <> 'true'
            AND NOT EXISTS (
              SELECT 1 FROM ${this.steeringInputsTable} own_input
              WHERE own_input.source_run_id = target.run_id
                AND own_input.state IN ('pending', 'reserved')
            )
          ORDER BY
            CASE target.status WHEN 'running' THEN 0 WHEN 'waiting_hand' THEN 0 ELSE 1 END,
            target.requested_at ASC
          LIMIT 1
          FOR UPDATE
        `, [input.sessionId, input.runId, input.model ?? null, input.executionTarget ?? null, input.workspaceId ?? null]);
        targetRunId = targetResult.rows[0]?.run_id;
      } else {
        const blockerResult = await client.query<{ run_id: string }>(`
          SELECT candidate.run_id
          FROM ${this.runsTable} candidate
          WHERE candidate.session_id = $1
            AND candidate.run_id <> $2
            AND candidate.status IN ('pending','running','waiting_hand')
            AND COALESCE(candidate.metadata->>'backgroundTask', 'false') <> 'true'
            AND NOT EXISTS (
              SELECT 1 FROM ${this.steeringInputsTable} own_input
              WHERE own_input.source_run_id = candidate.run_id
                AND own_input.state IN ('pending', 'reserved')
            )
          ORDER BY
            CASE candidate.status WHEN 'running' THEN 0 WHEN 'waiting_hand' THEN 0 ELSE 1 END,
            candidate.requested_at ASC
          LIMIT 1
          FOR UPDATE
        `, [input.sessionId, input.runId]);
        queuedBehindRunId = blockerResult.rows[0]?.run_id;
      }

      const metadata = {
        ...(input.metadata ?? {}),
        deliveryMode,
        acceptedAt: now,
        ...(queuedBehindRunId ? { queuedBehindRunId } : {}),
        ...(targetRunId ? { steeringTargetRunId: targetRunId, steeringState: 'pending' } : {}),
      };
      const result = await client.query<{ row_json: RunRecord }>(`
        INSERT INTO ${this.runsTable}
          (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at,
           idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata)
        VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (run_id) DO NOTHING
        RETURNING row_to_json(${this.runsTable}.*) AS row_json
      `, [
        input.runId,
        input.sessionId,
        input.userId ?? null,
        input.tenantId ?? null,
        input.model ?? null,
        input.channel ?? null,
        now,
        input.idempotencyKey,
        input.executionTarget ?? null,
        input.workspaceId ?? null,
        input.sandboxScopeId ?? null,
        userScope,
        JSON.stringify(metadata),
      ]);
      if (!result.rows[0]) throw new Error(`Run id collision: ${input.runId}`);
      if (targetRunId) {
        await client.query(`
          INSERT INTO ${this.steeringInputsTable}
            (input_id, source_run_id, target_run_id, session_id, state, accepted_at)
          VALUES ($1,$1,$2,$3,'pending',$4)
          ON CONFLICT (source_run_id) DO NOTHING
        `, [input.runId, targetRunId, input.sessionId, now]);
      }
      await client.query('COMMIT');
      return normalizeRunRecord(result.rows[0].row_json);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async listPendingSteeringInputs(targetRunId: string): Promise<SteeringInputRecord[]> {
    const result = await this.pool.query<{
      input_id: string;
      source_run_id: string;
      target_run_id: string;
      session_id: string;
      state: 'pending' | 'reserved';
      accepted_at: string | Date;
      reserved_at: string | Date | null;
      applied_at: string | Date | null;
      row_json: RunRecord;
    }>(`
      SELECT input.input_id, input.source_run_id, input.target_run_id, input.session_id,
             input.state, input.accepted_at, input.reserved_at, input.applied_at,
             row_to_json(source.*) AS row_json
      FROM ${this.steeringInputsTable} input
      JOIN ${this.runsTable} source ON source.run_id = input.source_run_id
      WHERE input.target_run_id = $1
        AND input.state IN ('pending', 'reserved')
        AND source.status = 'pending'
      ORDER BY input.sequence ASC
    `, [targetRunId]);
    return result.rows.map((row) => ({
      inputId: row.input_id,
      sourceRunId: row.source_run_id,
      targetRunId: row.target_run_id,
      sessionId: row.session_id,
      state: row.state,
      acceptedAt: new Date(row.accepted_at).toISOString(),
      ...(row.reserved_at ? { reservedAt: new Date(row.reserved_at).toISOString() } : {}),
      ...(row.applied_at ? { appliedAt: new Date(row.applied_at).toISOString() } : {}),
      sourceRun: normalizeRunRecord(row.row_json),
    }));
  }

  async reserveSteeringInputs(targetRunId: string, sourceRunIds: string[]): Promise<string[]> {
    if (sourceRunIds.length === 0) return [];
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{ status: RunStatus; metadata: Record<string, unknown> }>(`
        SELECT status, metadata
        FROM ${this.runsTable}
        WHERE run_id = $1
        FOR UPDATE
      `, [targetRunId]);
      const targetRow = target.rows[0];
      if (
        !targetRow
        || !ACTIVE_STEERING_TARGET_STATUSES.includes(targetRow.status)
        || targetRow.metadata?.steeringInputWindow === 'sealed'
      ) {
        await client.query('COMMIT');
        return [];
      }
      const sources = await client.query<{ run_id: string; status: RunStatus }>(`
        SELECT run_id, status
        FROM ${this.runsTable}
        WHERE run_id = ANY($1::text[])
        FOR UPDATE
      `, [sourceRunIds]);
      const pendingSourceRunIdSet = new Set(
        sources.rows.filter((row) => row.status === 'pending').map((row) => row.run_id),
      );
      const claimableSourceRunIds = sourceRunIds.filter((sourceRunId) => pendingSourceRunIdSet.has(sourceRunId));
      if (claimableSourceRunIds.length === 0) {
        await client.query('COMMIT');
        return [];
      }
      const reserved = await client.query<{ source_run_id: string }>(`
        UPDATE ${this.steeringInputsTable}
        SET state = 'reserved', reserved_at = COALESCE(reserved_at, $3::timestamptz)
        WHERE target_run_id = $1
          AND source_run_id = ANY($2::text[])
          AND state = 'pending'
        RETURNING source_run_id
      `, [targetRunId, claimableSourceRunIds, now]);
      const reservedRunIdSet = new Set(reserved.rows.map((row) => row.source_run_id));
      const alreadyReserved = await client.query<{ source_run_id: string }>(`
        SELECT source_run_id
        FROM ${this.steeringInputsTable}
        WHERE target_run_id = $1
          AND source_run_id = ANY($2::text[])
          AND state = 'reserved'
      `, [targetRunId, claimableSourceRunIds]);
      for (const row of alreadyReserved.rows) reservedRunIdSet.add(row.source_run_id);
      await client.query('COMMIT');
      return sourceRunIds.filter((sourceRunId) => reservedRunIdSet.has(sourceRunId));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markSteeringInputsApplied(targetRunId: string, sourceRunIds: string[]): Promise<string[]> {
    if (sourceRunIds.length === 0) return [];
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{ status: RunStatus; metadata: Record<string, unknown> }>(`
        SELECT status, metadata
        FROM ${this.runsTable}
        WHERE run_id = $1
        FOR UPDATE
      `, [targetRunId]);
      const targetRow = target.rows[0];
      if (
        !targetRow
        || !ACTIVE_STEERING_TARGET_STATUSES.includes(targetRow.status)
        || targetRow.metadata?.steeringInputWindow === 'sealed'
      ) {
        await client.query('COMMIT');
        return [];
      }
      const sources = await client.query<{ run_id: string; status: RunStatus }>(`
        SELECT run_id, status
        FROM ${this.runsTable}
        WHERE run_id = ANY($1::text[])
        FOR UPDATE
      `, [sourceRunIds]);
      const pendingSourceRunIdSet = new Set(
        sources.rows
          .filter((row) => row.status === 'pending')
          .map((row) => row.run_id),
      );
      // reserve 已在 durable append 前取得所有权；这里仅结算仍由本目标持有的子集。
      // source 状态锁继续保留，避免 janitor/人工状态修改与结算交错。
      const claimableSourceRunIds = sourceRunIds.filter((sourceRunId) => (
        pendingSourceRunIdSet.has(sourceRunId)
      ));
      if (claimableSourceRunIds.length === 0) {
        await client.query('COMMIT');
        return [];
      }
      const applied = await client.query<{ source_run_id: string }>(`
        UPDATE ${this.steeringInputsTable}
        SET state = 'applied', applied_at = $3::timestamptz
        WHERE target_run_id = $1
          AND source_run_id = ANY($2::text[])
          AND state = 'reserved'
        RETURNING source_run_id
      `, [targetRunId, claimableSourceRunIds, now]);
      const appliedRunIds = applied.rows.map((row) => row.source_run_id);
      if (appliedRunIds.length > 0) {
        await client.query(`
          UPDATE ${this.runsTable}
          SET status = 'completed',
              status_reason = 'steered_into_run',
              updated_at = $3,
              completed_at = $3,
              worker_id = NULL,
              lease_expires_at = NULL,
              metadata = (metadata || jsonb_build_object(
                'steeringState', 'applied',
                'steeringAppliedToRunId', $1::text,
                'steeringAppliedAt', $4::text
              )) - 'wakeMessage'
          WHERE run_id = ANY($2::text[]) AND status = 'pending'
        `, [targetRunId, appliedRunIds, now, now]);
      }
      await client.query('COMMIT');
      return appliedRunIds;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async applySteeringInputsAtomically(
    targetRunId: string,
    inputs: SteeringApplyInput[],
    tenantId: string,
  ): Promise<SteeringApplyResult> {
    if (inputs.length === 0) return { appliedSourceRunIds: [], events: [] };
    const sourceRunIds = [...new Set(inputs.map((input) => input.sourceRunId))];
    const client = await this.pool.connect();
    let appended: Array<PlatformEvent & { sequence: number }> = [];
    try {
      await client.query('BEGIN');
      const sessionLookup = await client.query<{ session_id: string }>(`
        SELECT session_id FROM ${this.runsTable} WHERE run_id = $1
      `, [targetRunId]);
      const sessionId = sessionLookup.rows[0]?.session_id;
      if (!sessionId) {
        await client.query('COMMIT');
        return { appliedSourceRunIds: [], events: [] };
      }
      // 全部 steering 写路径遵循 advisory(session) → target → source(run_id) → input(sequence)。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${this.runsTable}:message:${sessionId}`,
      ]);
      const target = await client.query<{ status: RunStatus; metadata: Record<string, unknown> }>(`
        SELECT status, metadata
        FROM ${this.runsTable}
        WHERE run_id = $1
        FOR UPDATE
      `, [targetRunId]);
      const targetRow = target.rows[0];
      if (
        !targetRow
        || !ACTIVE_STEERING_TARGET_STATUSES.includes(targetRow.status)
        || targetRow.metadata?.steeringInputWindow === 'sealed'
      ) {
        await client.query('COMMIT');
        return { appliedSourceRunIds: [], events: [] };
      }
      const sources = await client.query<{ run_id: string; status: RunStatus }>(`
        SELECT run_id, status
        FROM ${this.runsTable}
        WHERE run_id = ANY($1::text[])
        ORDER BY run_id
        FOR UPDATE
      `, [sourceRunIds]);
      const pendingSources = new Set(
        sources.rows.filter((row) => row.status === 'pending').map((row) => row.run_id),
      );
      const reserved = await client.query<{ source_run_id: string }>(`
        SELECT source_run_id
        FROM ${this.steeringInputsTable}
        WHERE target_run_id = $1
          AND source_run_id = ANY($2::text[])
          AND state = 'reserved'
        ORDER BY sequence
        FOR UPDATE
      `, [targetRunId, sourceRunIds]);
      const reservedSet = new Set(reserved.rows.map((row) => row.source_run_id));
      const appliedSourceRunIds = sourceRunIds.filter((id) => pendingSources.has(id) && reservedSet.has(id));
      if (appliedSourceRunIds.length === 0) {
        await client.query('COMMIT');
        return { appliedSourceRunIds: [], events: [] };
      }

      const { candidateEventInputs, candidateSourceRunIds } = selectSteeringEventCandidates(inputs, appliedSourceRunIds);
      const existingDurableSources = candidateSourceRunIds.length > 0
        ? await client.query<{ source_run_id: string }>(`
          SELECT DISTINCT event_json->>'interjectionSourceRunId' AS source_run_id
          FROM ${this.eventsTable}
          WHERE event_type = 'user_message'
            AND event_json->>'interjectionSourceRunId' = ANY($1::text[])
        `, [candidateSourceRunIds])
        : { rows: [] };
      appended = await this.appendRuntimeEventsInTransaction(client, buildAppliedSteeringEventInputs({
        inputs,
        appliedSourceRunIds,
        candidateEventInputs,
        existingDurableSourceSet: new Set(existingDurableSources.rows.map((row) => row.source_run_id)),
        targetRunId,
        sessionId,
      }), tenantId);
      const now = new Date().toISOString();
      await client.query(`
        UPDATE ${this.steeringInputsTable}
        SET state = 'applied', applied_at = $3::timestamptz
        WHERE target_run_id = $1
          AND source_run_id = ANY($2::text[])
          AND state = 'reserved'
      `, [targetRunId, appliedSourceRunIds, now]);
      await client.query(`
        UPDATE ${this.runsTable}
        SET status = 'completed',
            status_reason = 'steered_into_run',
            updated_at = $3::timestamptz,
            completed_at = $3::timestamptz,
            worker_id = NULL,
            lease_expires_at = NULL,
            metadata = (metadata || jsonb_build_object(
              'steeringState', 'applied',
              'steeringAppliedToRunId', $1::text,
              'steeringAppliedAt', $3::text
            )) - 'wakeMessage'
        WHERE run_id = ANY($2::text[]) AND status = 'pending'
      `, [targetRunId, appliedSourceRunIds, now]);
      await client.query('COMMIT');
      await this.notifyRuntimeEvents(client, appended);
      return { appliedSourceRunIds, events: appended };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async trySealSteeringInputWindow(targetRunId: string): Promise<boolean> {
    const sessionResult = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM ${this.runsTable} WHERE run_id = $1`,
      [targetRunId],
    );
    const sessionId = sessionResult.rows[0]?.session_id;
    if (!sessionId) return true;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${this.runsTable}:message:${sessionId}`,
      ]);
      const pending = await client.query(`
        SELECT 1
        FROM ${this.steeringInputsTable} input
        JOIN ${this.runsTable} source ON source.run_id = input.source_run_id
        WHERE input.target_run_id = $1
          AND input.state IN ('pending', 'reserved')
          AND source.status = 'pending'
        LIMIT 1
      `, [targetRunId]);
      if (pending.rowCount && pending.rowCount > 0) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(`
        UPDATE ${this.runsTable}
        SET metadata = metadata || jsonb_build_object('steeringInputWindow', 'sealed'),
            updated_at = $2
        WHERE run_id = $1
      `, [targetRunId, new Date().toISOString()]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releasePendingSteeringForSourceRun(sourceRunId: string): Promise<void> {
    await this.pool.query(`
      WITH released AS (
        UPDATE ${this.steeringInputsTable}
        SET state = 'released'
        WHERE source_run_id = $1 AND state IN ('pending', 'reserved')
      )
      UPDATE ${this.runsTable}
      SET metadata = (metadata - 'steeringTargetRunId')
            || jsonb_build_object('steeringState', 'released'),
          updated_at = $2
      WHERE run_id = $1 AND metadata->>'steeringState' = 'pending'
    `, [sourceRunId, new Date().toISOString()]);
  }

  async cancelPendingUserMessage(runId: string, reason = 'user_withdrew'): Promise<CancelSteeringResult> {
    const existing = await this.get(runId);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.metadata?.steeringState !== undefined || existing.metadata?.steeringTargetRunId !== undefined) {
      return this.cancelPendingSteeringSourceRun(runId, reason);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{ status: RunStatus; session_id: string; metadata: Record<string, unknown> }>(`
        SELECT status, session_id, metadata
        FROM ${this.runsTable}
        WHERE run_id = $1
        FOR UPDATE
      `, [runId]);
      const row = selected.rows[0];
      const clientMsgId = typeof row?.metadata?.clientMsgId === 'string' ? row.metadata.clientMsgId : undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      if (row.status !== 'pending') {
        await client.query('ROLLBACK');
        if (row.status === 'cancelled' && row.metadata?.cancelledByQueueRequest === true) {
          return { ok: true, sessionId: row.session_id, ...(clientMsgId ? { clientMsgId } : {}) };
        }
        return { ok: false, reason: 'too_late', sessionId: row.session_id, ...(clientMsgId ? { clientMsgId } : {}) };
      }
      const now = new Date().toISOString();
      await client.query(`
        UPDATE ${this.runsTable}
        SET status = 'cancelled', status_reason = $2, updated_at = $3, cancelled_at = $3,
            worker_id = NULL, lease_expires_at = NULL, metadata = (metadata || jsonb_build_object('cancelledByQueueRequest', true)) - 'wakeMessage'
        WHERE run_id = $1 AND status = 'pending'
      `, [runId, reason, now]);
      await client.query('COMMIT');
      return { ok: true, sessionId: row.session_id, ...(clientMsgId ? { clientMsgId } : {}) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelPendingSteeringSourceRun(sourceRunId: string, reason = 'user_withdrew'): Promise<CancelSteeringResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const source = await client.query<{ status: RunStatus; session_id: string; metadata: Record<string, unknown> }>(`
        SELECT status, session_id, metadata
        FROM ${this.runsTable}
        WHERE run_id = $1
        FOR UPDATE
      `, [sourceRunId]);
      const row = source.rows[0];
      const isSteeringSource = !!row && (
        row.metadata?.steeringState !== undefined || row.metadata?.steeringTargetRunId !== undefined
      );
      if (!row || !isSteeringSource) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const clientMsgId = typeof row.metadata?.clientMsgId === 'string' ? row.metadata.clientMsgId : undefined;
      if (row.status !== 'pending' || row.metadata?.steeringState !== 'pending') {
        await client.query('ROLLBACK');
        if (row.status === 'cancelled' && row.metadata?.cancelledByQueueRequest === true) {
          return { ok: true, sessionId: row.session_id, ...(clientMsgId ? { clientMsgId } : {}) };
        }
        return { ok: false, reason: 'too_late', sessionId: row.session_id, ...(clientMsgId ? { clientMsgId } : {}) };
      }
      const inputUpdate = await client.query(`
        UPDATE ${this.steeringInputsTable}
        SET state = 'cancelled'
        WHERE source_run_id = $1 AND state = 'pending'
      `, [sourceRunId]);
      if (inputUpdate.rowCount === 0) {
        // 行已被 claim（drain→claim 窗口）：消息已进入模型上下文，撤回太晚。
        await client.query('ROLLBACK');
        return { ok: false, reason: 'too_late', sessionId: row.session_id, ...(clientMsgId ? { clientMsgId } : {}) };
      }
      const now = new Date().toISOString();
      await client.query(`
        UPDATE ${this.runsTable}
        SET status = 'cancelled',
            status_reason = $2,
            updated_at = $3,
            completed_at = $3,
            metadata = (metadata || jsonb_build_object('steeringState', 'cancelled', 'cancelledByQueueRequest', true)) - 'wakeMessage'
        WHERE run_id = $1 AND status = 'pending'
      `, [sourceRunId, reason, now]);
      await client.query('COMMIT');
      return { ok: true, sessionId: row.session_id, ...(clientMsgId ? { clientMsgId } : {}) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async cancelSteeringBeforeDispatchBySession(
    sessionId: string,
    reason: string,
    targetRunId?: string,
  ): Promise<SteeringInputRecord[]> {
    const result = await this.cancelSteeringBeforeDispatchInternal(sessionId, reason, targetRunId, undefined, DEFAULT_TENANT_ID);
    return result.cancelled;
  }

  async cancelSteeringBeforeDispatchBySessionWithEvent(
    sessionId: string,
    reason: string,
    targetRunId: string | undefined,
    event: PlatformEventInput,
    tenantId: string,
  ): Promise<{ cancelled: SteeringInputRecord[]; targetCancelled: boolean; event?: PlatformEvent; eventCreated: boolean }> {
    const result = await this.cancelSteeringBeforeDispatchInternal(
      sessionId,
      reason,
      targetRunId,
      event,
      tenantId,
    );
    return {
      cancelled: result.cancelled,
      targetCancelled: result.targetCancelled,
      ...(result.event ? { event: result.event } : {}),
      eventCreated: result.eventCreated,
    };
  }

  private async cancelSteeringBeforeDispatchInternal(
    sessionId: string,
    reason: string,
    targetRunId: string | undefined,
    event: PlatformEventInput | undefined,
    tenantId: string,
  ): Promise<{ cancelled: SteeringInputRecord[]; targetCancelled: boolean; event?: PlatformEvent; eventCreated: boolean }> {
    const client = await this.pool.connect();
    let appended: Array<PlatformEvent & { sequence: number }> = [];
    let targetCancelled = false;
    let targetPreviousStatus: RunStatus | undefined;
    let runCancelEventCreated = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${this.runsTable}:message:${sessionId}`,
      ]);
      const now = new Date().toISOString();
      // 固定锁序：advisory(session) → target → source(run_id) → input(sequence)。
      // 必须先锁定并核验 target，再写 session stopped_at 或撤销排队项；否则状态预读后
      // target 并发终态化时，stop 会错误影响后续普通队列/steering。
      if (targetRunId) {
        const target = await client.query<{ status: RunStatus }>(`
          SELECT status
          FROM ${this.runsTable}
          WHERE session_id = $1 AND run_id = $2
          FOR UPDATE
        `, [sessionId, targetRunId]);
        targetPreviousStatus = target.rows[0]?.status;
        if (targetPreviousStatus && ['completed', 'failed', 'cancelled', 'orphaned'].includes(targetPreviousStatus)) {
          await client.query('COMMIT');
          return { cancelled: [], targetCancelled: false, eventCreated: false };
        }
      }
      await client.query(`
        INSERT INTO ${this.steeringSessionsTable} (session_id, stopped_at)
        VALUES ($1, $2::timestamptz)
        ON CONFLICT (session_id) DO UPDATE
        SET stopped_at = GREATEST(${this.steeringSessionsTable}.stopped_at, EXCLUDED.stopped_at)
      `, [sessionId, now]);
      const candidateIds = await client.query<{ source_run_id: string }>(`
        SELECT input.source_run_id
        FROM ${this.steeringInputsTable} input
        JOIN ${this.runsTable} source ON source.run_id = input.source_run_id
        WHERE input.session_id = $1
          AND input.state IN ('pending', 'reserved')
          AND source.status = 'pending'
        ORDER BY input.sequence
      `, [sessionId]);
      const sourceRunIds = candidateIds.rows.map((row) => row.source_run_id);
      if (sourceRunIds.length > 0) {
        await client.query(`
          SELECT run_id
          FROM ${this.runsTable}
          WHERE run_id = ANY($1::text[])
          ORDER BY run_id
          FOR UPDATE
        `, [sourceRunIds]);
        await client.query(`
          SELECT input_id
          FROM ${this.steeringInputsTable}
          WHERE source_run_id = ANY($1::text[])
          ORDER BY sequence
          FOR UPDATE
        `, [sourceRunIds]);
      }
      const selected = await client.query<{
        input_id: string;
        source_run_id: string;
        target_run_id: string;
        session_id: string;
        state: 'pending' | 'reserved';
        accepted_at: string | Date;
        reserved_at: string | Date | null;
        applied_at: string | Date | null;
        row_json: RunRecord;
      }>(`
        SELECT input.input_id, input.source_run_id, input.target_run_id, input.session_id,
               input.state, input.accepted_at, input.reserved_at, input.applied_at,
               row_to_json(source.*) AS row_json
        FROM ${this.steeringInputsTable} input
        JOIN ${this.runsTable} source ON source.run_id = input.source_run_id
        WHERE input.session_id = $1
          AND input.source_run_id = ANY($2::text[])
          AND input.state IN ('pending', 'reserved')
          AND source.status = 'pending'
        ORDER BY input.sequence ASC
        FOR UPDATE OF input, source
      `, [sessionId, sourceRunIds]);
      const selectedSourceRunIds = selected.rows.map((row) => row.source_run_id);
      const releasableTaskboardSourceRunIds = selected.rows
        .filter((row) => row.state === 'pending' && row.row_json.metadata?.taskboardContinuation === true)
        .map((row) => row.source_run_id);
      if (selectedSourceRunIds.length > 0) {
        await client.query(`
          UPDATE ${this.steeringInputsTable}
          SET state = CASE WHEN source_run_id = ANY($2::text[]) THEN 'released' ELSE 'cancelled' END
          WHERE session_id = $1 AND source_run_id = ANY($3::text[]) AND state IN ('pending', 'reserved')
        `, [sessionId, releasableTaskboardSourceRunIds, selectedSourceRunIds]);
        await client.query(`
          UPDATE ${this.runsTable}
          SET status = CASE WHEN run_id = ANY($2::text[]) THEN status ELSE 'cancelled' END,
              status_reason = CASE WHEN run_id = ANY($2::text[]) THEN status_reason ELSE $3 END, updated_at = $4::timestamptz,
              cancelled_at = CASE WHEN run_id = ANY($2::text[]) THEN cancelled_at ELSE $4::timestamptz END,
              metadata = CASE WHEN run_id = ANY($2::text[]) THEN (metadata - 'steeringTargetRunId') || jsonb_build_object('steeringState', 'released')
                ELSE (metadata || jsonb_build_object('steeringState', 'cancelled')) - 'wakeMessage' END
          WHERE run_id = ANY($1::text[]) AND status = 'pending'
        `, [selectedSourceRunIds, releasableTaskboardSourceRunIds, reason, now]);
      }
      let toolCancelEvents: PlatformEventInput[] = [];
      if (targetRunId) {
        const targetUpdate = await client.query<{ run_id: string; cancelled_at: string | Date }>(`
          UPDATE ${this.runsTable}
          SET status = 'cancelled',
              status_reason = $3,
              updated_at = clock_timestamp(),
              cancelled_at = clock_timestamp(),
              worker_id = NULL,
              lease_expires_at = NULL,
              metadata = metadata - 'wakeMessage'
          WHERE session_id = $1
            AND run_id = $2
            AND status IN ${STOPPABLE_RUN_STATUS_SQL}
          RETURNING run_id, cancelled_at
        `, [sessionId, targetRunId, reason]);
        targetCancelled = targetUpdate.rows.length > 0;
        const targetCancelledAt = targetUpdate.rows[0]?.cancelled_at;
        const targetCancelledAtIso = targetCancelledAt instanceof Date
          ? targetCancelledAt.toISOString()
          : targetCancelledAt ?? now;

        if (event && targetCancelled) {
          const cancelRequests = await client.query<{
            invocation_id: string;
            tool_call_id: string;
            tool_name: string;
            metadata: Record<string, unknown>;
          }>(`
            UPDATE ${this.toolInvocationsTable}
            SET cancel_requested_at = $2::timestamptz,
                cancel_reason = COALESCE(cancel_reason, $3),
                updated_at = $2::timestamptz,
                metadata = metadata || $4::jsonb
            WHERE run_id = $1
              AND status = 'running'
              AND cancel_requested_at IS NULL
            RETURNING invocation_id, tool_call_id, tool_name, metadata
          `, [targetRunId, targetCancelledAtIso, reason, JSON.stringify({ requestedBy: 'userId' in event ? event.userId ?? 'anonymous' : 'anonymous' })]);
          toolCancelEvents = cancelRequests.rows.map((invocation) => ({
            type: 'tool_invocation_cancel_requested',
            sessionId,
            runId: targetRunId,
            invocationId: invocation.invocation_id,
            toolCallId: invocation.tool_call_id,
            toolName: invocation.tool_name,
            ...('userId' in event && event.userId ? { userId: event.userId } : {}),
            reason,
            metadata: invocation.metadata,
          }));
        }
      }
      let existingEvent: PlatformEvent | undefined;
      if (event?.type === 'run_cancel_requested' && event.runId) {
        const existing = await client.query<{ event_json: PlatformEvent }>(`
          SELECT event_json
          FROM ${this.eventsTable}
          WHERE event_type = 'run_cancel_requested' AND run_id = $1
          ORDER BY session_sequence
          LIMIT 1
        `, [event.runId]);
        existingEvent = existing.rows[0]?.event_json;
      }
      const shouldAppendRunCancel = Boolean(event && !existingEvent && (!targetRunId || targetCancelled));
      const eventsToAppend = buildRunCancellationEvents(event, shouldAppendRunCancel, toolCancelEvents, sessionId, targetRunId, targetCancelled, targetPreviousStatus, reason);
      if (eventsToAppend.length > 0) {
        appended = await this.appendRuntimeEventsInTransaction(client, eventsToAppend, tenantId);
        runCancelEventCreated = shouldAppendRunCancel;
      }
      await client.query('COMMIT');
      await this.notifyRuntimeEvents(client, appended);
      const cancelled = selected.rows
        .filter((row) => row.row_json.metadata?.taskboardContinuation !== true)
        .map((row) => ({
          inputId: row.input_id,
          sourceRunId: row.source_run_id,
          targetRunId: row.target_run_id,
          sessionId: row.session_id,
          state: row.state,
          acceptedAt: new Date(row.accepted_at).toISOString(),
          ...(row.reserved_at ? { reservedAt: new Date(row.reserved_at).toISOString() } : {}),
          ...(row.applied_at ? { appliedAt: new Date(row.applied_at).toISOString() } : {}),
          sourceRun: normalizeRunRecord(row.row_json),
        }));
      const durableEvent = appended.find((item) => item.type === 'run_cancel_requested') ?? existingEvent;
      return {
        cancelled,
        targetCancelled,
        ...(durableEvent ? { event: durableEvent } : {}),
        eventCreated: runCancelEventCreated,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listPendingUserMessagesBySession(sessionId: string): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.runsTable} run
      WHERE run.session_id = $1
        AND run.status = 'pending'
        AND run.channel = 'web'
        AND run.metadata ? 'wakeMessage'
        AND COALESCE(run.metadata->>'backgroundTask', 'false') <> 'true'
      ORDER BY run.enqueue_seq ASC
    `, [sessionId]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }

  async listUserMessagesBySession(sessionId: string): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.runsTable} run
      WHERE run.session_id = $1
        AND run.channel = 'web'
        AND (run.metadata ? 'clientMsgId' OR run.idempotency_key IS NOT NULL)
        AND COALESCE(run.metadata->>'backgroundTask', 'false') <> 'true'
      ORDER BY run.enqueue_seq ASC
    `, [sessionId]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }

  async listPendingSteeringBySession(sessionId: string): Promise<SteeringInputRecord[]> {
    const result = await this.pool.query<{
      input_id: string;
      source_run_id: string;
      target_run_id: string;
      session_id: string;
      state: 'pending' | 'reserved' | 'applied' | 'released' | 'cancelled';
      accepted_at: string | Date;
      applied_at: string | Date | null;
      row_json: RunRecord;
    }>(`
      SELECT input.input_id, input.source_run_id, input.target_run_id, input.session_id,
             input.state, input.accepted_at, input.applied_at,
             row_to_json(source.*) AS row_json
      FROM ${this.steeringInputsTable} input
      JOIN ${this.runsTable} source ON source.run_id = input.source_run_id
      WHERE input.session_id = $1
        AND input.state = 'pending'
        AND source.status = 'pending'
      ORDER BY input.sequence ASC
    `, [sessionId]);
    return result.rows.map((row) => ({
      inputId: row.input_id,
      sourceRunId: row.source_run_id,
      targetRunId: row.target_run_id,
      sessionId: row.session_id,
      state: row.state,
      acceptedAt: new Date(row.accepted_at).toISOString(),
      ...(row.applied_at ? { appliedAt: new Date(row.applied_at).toISOString() } : {}),
      sourceRun: normalizeRunRecord(row.row_json),
    }));
  }

  async enqueueBackgroundTask(
    input: UpsertRunInput,
    limits: EnqueueBackgroundTaskLimits,
  ): Promise<RunRecord> {
    const parentRunId = stringMetadata(input.metadata, 'parentRunId');
    const parentSessionId = stringMetadata(input.metadata, 'parentSessionId');
    if (!parentRunId || !parentSessionId || input.metadata?.backgroundTask !== true) {
      throw new Error('enqueueBackgroundTask requires backgroundTask/parentRunId/parentSessionId metadata');
    }
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 后台任务创建频率低，用单一事务锁换取多 brain 下明确的硬配额语义。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${this.runsTable}:background-task-quota`]);
      const counts = await client.query<{
        parent_active: string | number;
        tenant_active: string | number;
      }>(`
        SELECT
          COUNT(*) FILTER (
            WHERE metadata->>'parentRunId' = $1
              AND status IN ('pending','running')
          ) AS parent_active,
          COUNT(*) FILTER (
            WHERE tenant_id = $2
              AND status IN ('pending','running')
          ) AS tenant_active
        FROM ${this.runsTable}
        WHERE metadata->>'backgroundTask' = 'true'
      `, [parentRunId, tenantId]);
      const row = counts.rows[0];
      const parentActive = parseCount(row?.parent_active);
      const tenantActive = parseCount(row?.tenant_active);
      if (parentActive >= limits.perParentActive) {
        throw new BackgroundTaskLimitError(`本次运行同时活跃的后台任务已达上限 ${limits.perParentActive}`);
      }
      if (tenantActive >= limits.perTenantActive) {
        throw new BackgroundTaskLimitError(`当前组织同时活跃的后台任务已达上限 ${limits.perTenantActive}`);
      }

      const now = new Date().toISOString();
      const result = await client.query<{ row_json: RunRecord }>(`
        INSERT INTO ${this.runsTable}
          (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at,
           idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata)
        VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (run_id) DO NOTHING
        RETURNING row_to_json(${this.runsTable}.*) AS row_json
      `, [
        input.runId,
        input.sessionId,
        input.userId ?? null,
        tenantId,
        input.model ?? null,
        input.channel ?? null,
        now,
        input.idempotencyKey ?? null,
        input.executionTarget ?? null,
        input.workspaceId ?? null,
        input.sandboxScopeId ?? null,
        input.submitterUserId ?? input.userId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]);
      if (!result.rows[0]) throw new Error(`background task run already exists: ${input.runId}`);
      await client.query('COMMIT');
      return normalizeRunRecord(result.rows[0].row_json);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listBackgroundTasks(
    parentSessionId: string,
    options: ListBackgroundTasksOptions = {},
  ): Promise<RunRecord[]> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 20), 1), 100);
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE metadata->>'backgroundTask' = 'true'
        AND metadata->>'parentSessionId' = $1
        AND ($2::text IS NULL OR user_id = $2)
        AND ($3::text IS NULL OR tenant_id = $3)
      ORDER BY requested_at DESC
      LIMIT $4
    `, [parentSessionId, options.userId ?? null, options.tenantId ?? null, limit]);
    return result.rows.map((entry) => normalizeRunRecord(entry.row_json));
  }
  hasTaskboardSessionActivity(sessionIds: string[], tenantId?: string): Promise<boolean> { return hasTaskboardSessionActivity(this, sessionIds, tenantId); }
  findBackgroundTasksByIdentifier(parentSessionId: string, identifier: string, options: Pick<ListBackgroundTasksOptions, 'userId' | 'tenantId'> = {}): Promise<RunRecord[]> { return this.queries.findBackgroundTasksByIdentifier(parentSessionId, identifier, options); }
  async listPendingBackgroundTaskWakes(staleBefore: Date, limit = 50): Promise<RunRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(${this.runsTable}.*) AS row_json
      FROM ${this.runsTable}
      WHERE metadata->>'backgroundTask' = 'true'
        AND status IN ('completed','failed','cancelled','orphaned')
        AND (
          COALESCE(metadata->>'wakeState', 'pending') = 'pending'
          OR (
            metadata->>'wakeState' = 'delivering'
            AND COALESCE((metadata->>'wakeClaimedAt')::timestamptz, '-infinity'::timestamptz) < $1
          )
        )
      ORDER BY updated_at ASC
      LIMIT $2
    `, [staleBefore.toISOString(), boundedLimit]);
    return result.rows.map((entry) => normalizeRunRecord(entry.row_json));
  }
  async claimBackgroundTaskWake(
    runId: string,
    claimToken: string,
    staleBefore: Date,
  ): Promise<RunRecord | null> {
    const now = new Date().toISOString();
    const patch = JSON.stringify({ wakeState: 'delivering', wakeClaimToken: claimToken, wakeClaimedAt: now });
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET metadata = metadata || $4::jsonb,
          updated_at = $5
      WHERE run_id = $1
        AND length($2::text) > 0
        AND metadata->>'backgroundTask' = 'true'
        AND status IN ('completed','failed','cancelled','orphaned')
        AND (
          COALESCE(metadata->>'wakeState', 'pending') = 'pending'
          OR (
            metadata->>'wakeState' = 'delivering'
            AND COALESCE((metadata->>'wakeClaimedAt')::timestamptz, '-infinity'::timestamptz) < $3
          )
        )
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, claimToken, staleBefore.toISOString(), patch, now]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }

  async finishBackgroundTaskWake(
    runId: string,
    claimToken: string,
    state: 'pending' | 'queued' | 'discarded',
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const now = new Date().toISOString();
    const patch = JSON.stringify({
      ...metadataPatch,
      wakeState: state,
      wakeFinishedAt: now,
      wakeClaimToken: null,
    });
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET metadata = metadata || $4::jsonb,
          updated_at = $5
      WHERE run_id = $1
        AND metadata->>'wakeState' = 'delivering'
        AND metadata->>'wakeClaimToken' = $2
        AND $3::text IN ('pending','queued','discarded')
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, claimToken, state, patch, now]);
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  }
  async markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> { return this.queries.markStatus(runId, status, reason, metadataPatch); }
  async activateStagedRun(runId: string): Promise<RunRecord | null> { return this.queries.activateStagedRun(runId); }
  async claimPersistedInteractionResume(runId: string, expectedStatuses: readonly RunStatus[], reason: string, metadataPatch: Record<string, unknown>): Promise<RunRecord | null> { return this.queries.claimPersistedInteractionResume(runId, expectedStatuses, reason, metadataPatch); }

  async listStagedPersistedInteractionResumes(limit?: number): Promise<RunRecord[]> { return this.queries.listStagedPersistedInteractionResumes(limit); }
  async activatePersistedInteractionResume(runId: string, claim: Record<string, unknown>, metadataPatch?: Record<string, unknown>): Promise<RunRecord | null> { return this.queries.activatePersistedInteractionResume(runId, claim, metadataPatch); }
  async rollbackPersistedInteractionResume(runId: string, claim: Record<string, unknown>, waitingStatus: 'waiting_user' | 'waiting_approval', reason?: string): Promise<RunRecord | null> { return this.queries.rollbackPersistedInteractionResume(runId, claim, waitingStatus, reason); }
  async stagePendingRun(runId: string): Promise<RunRecord | null> { return this.queries.stagePendingRun(runId); }
  async cancelPendingTaskboardRun(runId: string, reason: string): Promise<RunRecord | null> { return this.queries.cancelPendingTaskboardRun(runId, reason); }
  async markStatusIfCurrent(runId: string, expectedStatuses: readonly RunStatus[], nextStatus: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> { return this.queries.markStatusIfCurrent(runId, expectedStatuses, nextStatus, reason, metadataPatch); }
  async patchMetadata(runId: string, metadataPatch: Record<string, unknown>): Promise<RunRecord | null> { return this.queries.patchMetadata(runId, metadataPatch); }
  async get(runId: string): Promise<RunRecord | null> { return this.queries.get(runId); }
  async cancelActiveByUser(userId: string, reason: string): Promise<number> { return this.queries.cancelActiveByUser(userId, reason); }
  async cancelActiveByTenant(tenantId: string, reason: string): Promise<number> { return this.queries.cancelActiveByTenant(tenantId, reason); } async listActiveByUser(userId: string): Promise<RunRecord[]> { return this.queries.listActiveByUser(userId); }
  async updateApprovalPolicyForActiveByUser(userId: string, approvalPolicy: Record<string, unknown> | null): Promise<string[]> { return this.queries.updateApprovalPolicyForActiveByUser(userId, approvalPolicy); }
  async findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    return this.queries.findByIdempotencyKey(userId, idempotencyKey);
  }
  async getActiveBySession(sessionId: string): Promise<RunRecord | null> { return this.queries.getActiveBySession(sessionId); }
  async getActiveCounts(): Promise<ActiveRunCounts> { return this.queries.getActiveCounts(); }
  async listBySession(sessionId: string, options: { limit?: number; beforeUpdatedAt?: string } = {}): Promise<RunRecord[]> {
    return this.queries.listBySession(sessionId, options);
  }
  async listSessionIdsByTenant(tenantId: string): Promise<string[]> { return this.queries.listSessionIdsByTenant(tenantId); }
  async deleteByTenant(tenantId: string): Promise<number> { return this.queries.deleteByTenant(tenantId); }
  async listRecoverable(now = new Date()): Promise<RunRecord[]> { return this.queries.listRecoverable(now); }
  async listStaleWaitingApproval(cutoff: Date, limit = 50): Promise<RunRecord[]> {
    return this.queries.listStaleWaitingApproval(cutoff, limit);
  }
  async cancelStaleWaitingApproval(runId: string, cutoff: Date, reason: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> {
    return this.queries.cancelStaleWaitingApproval(runId, cutoff, reason, metadataPatch);
  }
  async acquireLease(runId: string, workerId: string, leaseMs: number, now = new Date(), maxConcurrentRuns?: number, admission?: RunLeaseAdmission): Promise<RunRecord | null> {
    return this.queries.acquireLease(runId, workerId, leaseMs, now, maxConcurrentRuns, admission);
  }
  async renewLease(runId: string, workerId: string, leaseMs: number, now = new Date()): Promise<RunRecord | null> {
    return this.queries.renewLease(runId, workerId, leaseMs, now);
  }
  async updateResponseSessionState(runId: string, patch: ResponseSessionStatePatch): Promise<RunRecord | null> {
    return this.queries.updateResponseSessionState(runId, patch);
  }
  async findLatestResponseSessionStateBySession(sessionId: string, now = new Date()): Promise<LatestResponseSessionState | null> {
    return this.queries.findLatestResponseSessionStateBySession(sessionId, now);
  }
  async clearResponseSessionStateBySession(sessionId: string): Promise<number> {
    return this.queries.clearResponseSessionStateBySession(sessionId);
  }

  private async appendRuntimeEventsInTransaction(
    client: PgPoolClient,
    events: PlatformEventInput[],
    tenantId: string,
  ): Promise<Array<PlatformEvent & { sequence: number }>> {
    if (events.length === 0) return [];
    const sessionIds = new Set(events.map((event) => event.sessionId).filter(Boolean));
    if (sessionIds.size !== 1) throw new Error('Atomic runtime event append requires one session');
    const sessionId = [...sessionIds][0]!;
    // Must match PgEventStore.appendBatch: hold through the caller's COMMIT so BIGSERIAL
    // allocation order cannot diverge from durable commit order across the two writers.
    await lockPgEventGlobalSequence(client, this.eventsTable);
    const startSequence = await allocatePgEventSequences(
      client,
      this.eventCursorsTable,
      tenantId,
      sessionId,
      events.length,
    );
    const timestamp = new Date().toISOString();
    const fullEvents = events.map((event, index) => ({
      id: randomUUID(),
      timestamp,
      ...event,
      sequence: startSequence + index,
    }) as PlatformEvent & { sequence: number });
    for (const event of fullEvents) {
      await client.query(`
        INSERT INTO ${this.eventsTable}
          (session_id, session_sequence, event_id, event_type, run_id, tenant_id, timestamp, event_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      `, [
        event.sessionId,
        event.sequence,
        event.id,
        event.type,
        'runId' in event ? event.runId : null,
        tenantId,
        event.timestamp,
        serializeRuntimeEvent(event),
      ]);
    }
    return fullEvents;
  }

  private async notifyRuntimeEvents(
    client: PgPoolClient,
    events: Array<PlatformEvent & { sequence: number }>,
  ): Promise<void> {
    if (events.length === 0) return;
    await client.query('SELECT pg_notify($1, $2)', [
      this.eventNotifyChannel,
      encodePgEventNotifyPayload(events),
    ]).catch(() => undefined);
  }

  async releaseLease(runId: string, workerId: string, finalStatus?: RunStatus, reason?: string): Promise<RunRecord | null> {
    return releaseRunLease({
      pool: this.pool,
      runsTable: this.runsTable,
      normalizeRunRecord,
    }, runId, workerId, finalStatus, reason);
  }
}
