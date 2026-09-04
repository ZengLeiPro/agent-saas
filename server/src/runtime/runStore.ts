import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { allocatePgEventSequences } from './pgEventCursorAllocator.js';
import { encodePgEventNotifyPayload, lockPgEventGlobalSequence } from './pgEventStoreProtocol.js';
import type { PlatformEvent, PlatformEventInput } from './types.js';
import { buildRunCancellationEvents } from './runCancellationEvents.js';
import { releaseRunLease } from './runTerminalLifecycle.js';
import { ACTIVE_STEERING_TARGET_STATUSES, STEERING_TARGET_STATUS_SQL, STOPPABLE_RUN_STATUS_SQL } from './runStatusPolicy.js';
import { normalizeRunRecord, parseCount, sanitizeIdentifier, serializeRuntimeEvent, stringMetadata } from './runStoreRecordHelpers.js';
import { PgRunStoreQueries } from './runStoreQueries.js';
import { contractPgRunStoreTenantSchema, disablePgRunStoreLegacyWriterCapability, initializePgRunStore, recordPgRunStoreDrainEvidence, registerPgRunStoreLegacyWriterCapability, registerPgRunStoreTenantNativeWriterCapability, type PgRunStoreContractGate, type PgRunStoreDrainEvidence, type PgRunStoreLegacyWriterCapability } from './runStoreSchema.js';
import { hasTaskboardSessionActivity } from './runStoreSessionActivity.js';
import { lockRawTenantKey, readSameTenantSubmissionRun, upsertSteeringStopAuthority } from './runStoreTenantRolling.js';
import { acquireSandboxCleanupClaimGuard } from './sandboxRunAdmissionFence.js';
import { buildAppliedSteeringEventInputs, selectSteeringEventCandidates } from './steeringRuntimeEvents.js';
const { Pool } = pg;
type PgPoolClient = pg.PoolClient;
export * from './runStoreTypes.js';
import { BackgroundTaskLimitError, RunCreateConflictError } from './runStoreTypes.js';
import type { ActiveRunCounts, CancelSteeringResult, EnqueueBackgroundTaskLimits, LatestResponseSessionState, ListBackgroundTasksOptions, MessageDeliveryMode, PgPool, PgRunStoreOptions, ResponseSessionStatePatch, RunLeaseAdmission, RunLeaseAuthority, RunLeaseIdentity, RunLeaseReleaseOptions, RunRecord, RunStatus, RunStore, SandboxCleanupClaimGuard, SteeringApplyInput, SteeringApplyResult, SteeringInputRecord, UpsertRunInput } from './runStoreTypes.js';
import type { LivenessReapResult, RunHeartbeatSource } from './runLiveness.js';
export class PgRunStore implements RunStore {
  readonly pool: PgPool; readonly runsTable: string;
  readonly messageSubmissionsTable: string; readonly steeringInputsTable: string;
  readonly steeringSessionsTable: string; readonly eventsTable: string;
  readonly eventCursorsTable: string;
  readonly toolInvocationsTable: string;
  readonly eventNotifyChannel: string;
  private readonly ownsPool: boolean; readonly writerCapability: PgRunStoreOptions['writerCapability'];
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
    this.writerCapability = options.writerCapability;
    this.queries = new PgRunStoreQueries(
      this.pool,
      this.runsTable,
      this.messageSubmissionsTable,
      this.steeringInputsTable,
      this.toolInvocationsTable,
    );
  }
  async init(): Promise<void> { await initializePgRunStore(this); }
  async registerTenantNativeWriterCapability(dbRole: string): Promise<void> { await registerPgRunStoreTenantNativeWriterCapability(this, dbRole); }
  async registerLegacyWriterCapability(capability: PgRunStoreLegacyWriterCapability): Promise<void> { await registerPgRunStoreLegacyWriterCapability(this, capability); }
  async disableLegacyWriterCapability(dbRole: string): Promise<void> { await disablePgRunStoreLegacyWriterCapability(this, dbRole); }
  async recordTenantDrainEvidence(evidence: PgRunStoreDrainEvidence): Promise<void> { await recordPgRunStoreDrainEvidence(this, evidence); }
  async contractTenantSchema(gate: PgRunStoreContractGate): Promise<void> { await contractPgRunStoreTenantSchema(this, gate); }
  async close(): Promise<void> { if (this.ownsPool) await this.pool.end(); }
  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      INSERT INTO ${this.runsTable}
        (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at, idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata,
         liveness_state, liveness_detected_at, liveness_version)
      VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb,
         'active',$7,1)
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
        liveness_state = CASE WHEN ${this.runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                              THEN 'active' ELSE ${this.runsTable}.liveness_state END,
        liveness_reason_code = CASE WHEN ${this.runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                                    THEN NULL ELSE ${this.runsTable}.liveness_reason_code END,
        liveness_detected_at = CASE WHEN ${this.runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                                    THEN EXCLUDED.updated_at ELSE ${this.runsTable}.liveness_detected_at END,
        liveness_version = CASE WHEN ${this.runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                                THEN COALESCE(${this.runsTable}.liveness_version,0)+1 ELSE ${this.runsTable}.liveness_version END,
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
          (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at, idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata,
           liveness_state, liveness_detected_at, liveness_version)
        VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb,
           'active',$7,1)
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
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        tenantId,
        `${this.runsTable}:message:${input.sessionId}`,
      ]);
      const now = new Date().toISOString();
      const userScope = input.submitterUserId ?? input.userId ?? '__anonymous__';
      // Serialize expand's global raw key so conflicts become business errors rather than 23505.
      await lockRawTenantKey(client, `${this.messageSubmissionsTable}:raw-key`,
        `${userScope}\u001f${input.idempotencyKey}`);
      const submission = await client.query<{ run_id: string }>(`
        INSERT INTO ${this.messageSubmissionsTable}
          (tenant_id, user_scope, client_message_id, run_id, session_id, delivery_mode, accepted_at,
           tenant_user_scope, tenant_client_message_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT DO NOTHING
        RETURNING run_id
      `, [tenantId, userScope, input.idempotencyKey, input.runId, input.sessionId,
        deliveryMode, now, userScope, input.idempotencyKey]);
      if (!submission.rows[0]) {
        const existing = await readSameTenantSubmissionRun(client, this, tenantId,
          userScope, input.idempotencyKey);
        await client.query('COMMIT');
        return normalizeRunRecord(existing);
      }
      const acceptedAt = typeof input.metadata?.steeringAcceptedAt === 'string'
        ? input.metadata.steeringAcceptedAt
        : undefined;
      if (deliveryMode === 'steer' && acceptedAt) {
        const stop = await client.query<{ stopped_at: string | Date | null }>(`
          SELECT stopped_at
          FROM ${this.steeringSessionsTable}
          WHERE tenant_id = $1 AND tenant_session_id = $2
        `, [tenantId, input.sessionId]);
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
          WHERE target.tenant_id = $1
            AND target.session_id = $2
            AND target.run_id <> $3
            AND target.status IN ${STEERING_TARGET_STATUS_SQL}
            AND target.channel = 'web'
            AND target.model IS NOT DISTINCT FROM $4::text
            AND target.execution_target IS NOT DISTINCT FROM $5::text
            AND target.workspace_id IS NOT DISTINCT FROM $6::text
            AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open'
            AND COALESCE(target.metadata->>'backgroundTask', 'false') <> 'true'
            AND NOT EXISTS (
              SELECT 1 FROM ${this.steeringInputsTable} own_input
              WHERE own_input.tenant_id = target.tenant_id
                AND own_input.session_id = target.session_id
                AND own_input.source_run_id = target.run_id
                AND own_input.state IN ('pending', 'reserved')
            )
          ORDER BY
            CASE target.status WHEN 'running' THEN 0 WHEN 'waiting_hand' THEN 0 ELSE 1 END,
            target.requested_at ASC
          LIMIT 1
          FOR UPDATE
        `, [tenantId, input.sessionId, input.runId, input.model ?? null, input.executionTarget ?? null, input.workspaceId ?? null]);
        targetRunId = targetResult.rows[0]?.run_id;
      } else {
        const blockerResult = await client.query<{ run_id: string }>(`
          SELECT candidate.run_id
          FROM ${this.runsTable} candidate
          WHERE candidate.tenant_id = $1
            AND candidate.session_id = $2
            AND candidate.run_id <> $3
            AND candidate.status IN ('pending','running','waiting_hand')
            AND COALESCE(candidate.metadata->>'backgroundTask', 'false') <> 'true'
            AND NOT EXISTS (
              SELECT 1 FROM ${this.steeringInputsTable} own_input
              WHERE own_input.tenant_id = candidate.tenant_id
                AND own_input.session_id = candidate.session_id
                AND own_input.source_run_id = candidate.run_id
                AND own_input.state IN ('pending', 'reserved')
            )
          ORDER BY
            CASE candidate.status WHEN 'running' THEN 0 WHEN 'waiting_hand' THEN 0 ELSE 1 END,
            candidate.requested_at ASC
          LIMIT 1
          FOR UPDATE
        `, [tenantId, input.sessionId, input.runId]);
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
           idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata,
           liveness_state, liveness_detected_at, liveness_version)
        VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb,
           'active',$7,1)
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
            (input_id, tenant_id, source_run_id, target_run_id, session_id, state, accepted_at)
          VALUES ($1,$2,$1,$3,$4,'pending',$5)
          ON CONFLICT (source_run_id) DO NOTHING
        `, [input.runId, tenantId, targetRunId, input.sessionId, now]);
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
      JOIN ${this.runsTable} target
        ON target.tenant_id = input.tenant_id
       AND target.session_id = input.session_id
       AND target.run_id = input.target_run_id
      JOIN ${this.runsTable} source
        ON source.tenant_id = input.tenant_id
       AND source.session_id = input.session_id
       AND source.run_id = input.source_run_id
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
    // targetRunId remains API-compatible; its locked row resolves authoritative tenant/session.
    if (sourceRunIds.length === 0) return [];
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{ status: RunStatus; metadata: Record<string, unknown>; tenant_id: string; session_id: string }>(`
        SELECT status, metadata, tenant_id, session_id
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
      const { tenant_id: tenantId, session_id: sessionId } = targetRow;
      const sources = await client.query<{ run_id: string; status: RunStatus }>(`
        SELECT run_id, status
        FROM ${this.runsTable}
        WHERE tenant_id = $1 AND session_id = $2 AND run_id = ANY($3::text[])
        FOR UPDATE
      `, [tenantId, sessionId, sourceRunIds]);
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
        SET state = 'reserved', reserved_at = COALESCE(reserved_at, $5::timestamptz)
        WHERE tenant_id = $1 AND session_id = $2 AND target_run_id = $3
          AND source_run_id = ANY($4::text[])
          AND state = 'pending'
        RETURNING source_run_id
      `, [tenantId, sessionId, targetRunId, claimableSourceRunIds, now]);
      const reservedRunIdSet = new Set(reserved.rows.map((row) => row.source_run_id));
      const alreadyReserved = await client.query<{ source_run_id: string }>(`
        SELECT source_run_id
        FROM ${this.steeringInputsTable}
        WHERE tenant_id = $1 AND session_id = $2 AND target_run_id = $3
          AND source_run_id = ANY($4::text[])
          AND state = 'reserved'
      `, [tenantId, sessionId, targetRunId, claimableSourceRunIds]);
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
        SELECT session_id FROM ${this.runsTable} WHERE tenant_id = $1 AND run_id = $2
      `, [tenantId, targetRunId]);
      const sessionId = sessionLookup.rows[0]?.session_id;
      if (!sessionId) {
        await client.query('COMMIT');
        return { appliedSourceRunIds: [], events: [] };
      }
      // 全部 steering 写路径遵循 advisory(tenant/session) → target → source(run_id) → input(sequence)。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        tenantId,
        `${this.runsTable}:message:${sessionId}`,
      ]);
      const target = await client.query<{ status: RunStatus; metadata: Record<string, unknown> }>(`
        SELECT status, metadata
        FROM ${this.runsTable}
        WHERE tenant_id = $1 AND session_id = $2 AND run_id = $3
        FOR UPDATE
      `, [tenantId, sessionId, targetRunId]);
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
        WHERE tenant_id = $1 AND session_id = $2 AND run_id = ANY($3::text[])
        ORDER BY run_id
        FOR UPDATE
      `, [tenantId, sessionId, sourceRunIds]);
      const pendingSources = new Set(
        sources.rows.filter((row) => row.status === 'pending').map((row) => row.run_id),
      );
      const reserved = await client.query<{ source_run_id: string }>(`
        SELECT source_run_id
        FROM ${this.steeringInputsTable}
        WHERE tenant_id = $1 AND session_id = $2 AND target_run_id = $3
          AND source_run_id = ANY($4::text[])
          AND state = 'reserved'
        ORDER BY sequence
        FOR UPDATE
      `, [tenantId, sessionId, targetRunId, sourceRunIds]);
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
        SET state = 'applied', applied_at = $5::timestamptz
        WHERE tenant_id = $1 AND session_id = $2 AND target_run_id = $3
          AND source_run_id = ANY($4::text[])
          AND state = 'reserved'
      `, [tenantId, sessionId, targetRunId, appliedSourceRunIds, now]);
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
        WHERE tenant_id = $4 AND session_id = $5
          AND run_id = ANY($2::text[]) AND status = 'pending'
      `, [targetRunId, appliedSourceRunIds, now, tenantId, sessionId]);
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
    const sessionResult = await this.pool.query<{ session_id: string; tenant_id: string }>(
      `SELECT session_id, tenant_id FROM ${this.runsTable} WHERE run_id = $1`,
      [targetRunId],
    );
    const sessionId = sessionResult.rows[0]?.session_id;
    const tenantId = sessionResult.rows[0]?.tenant_id;
    if (!sessionId || !tenantId) return true;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        tenantId,
        `${this.runsTable}:message:${sessionId}`,
      ]);
      const pending = await client.query(`
        SELECT 1
        FROM ${this.steeringInputsTable} input
        JOIN ${this.runsTable} source
          ON source.tenant_id = input.tenant_id
         AND source.session_id = input.session_id
         AND source.run_id = input.source_run_id
        WHERE input.tenant_id = $1 AND input.session_id = $2 AND input.target_run_id = $3
          AND input.state IN ('pending', 'reserved')
          AND source.status = 'pending'
        LIMIT 1
      `, [tenantId, sessionId, targetRunId]);
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
    tenantId = DEFAULT_TENANT_ID,
  ): Promise<SteeringInputRecord[]> {
    const result = await this.cancelSteeringBeforeDispatchInternal(sessionId, reason, targetRunId, undefined, tenantId);
    return result.cancelled;
  }
  async cancelSteeringBeforeDispatchBySessionWithEvent(
    sessionId: string, reason: string, targetRunId: string | undefined,
    event: PlatformEventInput, tenantId: string,
    cleanupGuard?: SandboxCleanupClaimGuard): Promise<{ cancelled: SteeringInputRecord[]; targetCancelled: boolean; event?: PlatformEvent; eventCreated: boolean }> {
    const result = await this.cancelSteeringBeforeDispatchInternal(
      sessionId,
      reason,
      targetRunId, event, tenantId, cleanupGuard,
    );
    return {
      cancelled: result.cancelled,
      targetCancelled: result.targetCancelled,
      ...(result.event ? { event: result.event } : {}),
      eventCreated: result.eventCreated,
    };
  }
  private async cancelSteeringBeforeDispatchInternal(
    sessionId: string, reason: string, targetRunId: string | undefined,
    event: PlatformEventInput | undefined, tenantId: string,
    cleanupGuard?: SandboxCleanupClaimGuard): Promise<{ cancelled: SteeringInputRecord[]; targetCancelled: boolean; event?: PlatformEvent; eventCreated: boolean }> {
    const client = await this.pool.connect();
    let appended: Array<PlatformEvent & { sequence: number }> = [];
    let targetCancelled = false;
    let targetPreviousStatus: RunStatus | undefined;
    let runCancelEventCreated = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        tenantId,
        `${this.runsTable}:message:${sessionId}`,
      ]);
      if (cleanupGuard && !await acquireSandboxCleanupClaimGuard(client, this.runsTable, cleanupGuard)) {
        await client.query('COMMIT'); return { cancelled: [], targetCancelled: false, eventCreated: false };
      }
      const now = new Date().toISOString();
      // 固定锁序：advisory(tenant/session/raw key) → target → source(run_id) → input(sequence)。
      // 必须先锁定并核验 target，再写 session stopped_at 或撤销排队项；否则状态预读后
      // target 并发终态化时，stop 会错误影响后续普通队列/steering。
      if (targetRunId) {
        const target = await client.query<{ status: RunStatus }>(`
          SELECT status
          FROM ${this.runsTable}
          WHERE tenant_id = $1 AND session_id = $2 AND run_id = $3
          FOR UPDATE
        `, [tenantId, sessionId, targetRunId]);
        targetPreviousStatus = target.rows[0]?.status;
        if (targetPreviousStatus && ['completed', 'failed', 'cancelled', 'orphaned'].includes(targetPreviousStatus)) {
          await client.query('COMMIT');
          return { cancelled: [], targetCancelled: false, eventCreated: false };
        }
      }
      await upsertSteeringStopAuthority(client, this, tenantId, sessionId, now);
      const candidateIds = await client.query<{ source_run_id: string }>(`
        SELECT input.source_run_id
        FROM ${this.steeringInputsTable} input
        JOIN ${this.runsTable} source
          ON source.tenant_id = input.tenant_id
         AND source.session_id = input.session_id
         AND source.run_id = input.source_run_id
        WHERE input.tenant_id = $1
          AND input.session_id = $2
          AND input.state IN ('pending', 'reserved')
          AND source.status = 'pending'
        ORDER BY input.sequence
      `, [tenantId, sessionId]);
      const sourceRunIds = candidateIds.rows.map((row) => row.source_run_id);
      if (sourceRunIds.length > 0) {
        await client.query(`
          SELECT run_id
          FROM ${this.runsTable}
          WHERE tenant_id = $1 AND session_id = $2 AND run_id = ANY($3::text[])
          ORDER BY run_id
          FOR UPDATE
        `, [tenantId, sessionId, sourceRunIds]);
        await client.query(`
          SELECT input_id
          FROM ${this.steeringInputsTable}
          WHERE tenant_id = $1 AND session_id = $2 AND source_run_id = ANY($3::text[])
          ORDER BY sequence
          FOR UPDATE
        `, [tenantId, sessionId, sourceRunIds]);
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
        JOIN ${this.runsTable} source
          ON source.tenant_id = input.tenant_id
         AND source.session_id = input.session_id
         AND source.run_id = input.source_run_id
        WHERE input.tenant_id = $1
          AND input.session_id = $2
          AND input.source_run_id = ANY($3::text[])
          AND input.state IN ('pending', 'reserved')
          AND source.status = 'pending'
        ORDER BY input.sequence ASC
        FOR UPDATE OF input, source
      `, [tenantId, sessionId, sourceRunIds]);
      const selectedSourceRunIds = selected.rows.map((row) => row.source_run_id);
      const releasableTaskboardSourceRunIds = selected.rows
        .filter((row) => row.state === 'pending' && row.row_json.metadata?.taskboardContinuation === true)
        .map((row) => row.source_run_id);
      if (selectedSourceRunIds.length > 0) {
        await client.query(`
          UPDATE ${this.steeringInputsTable}
          SET state = CASE WHEN source_run_id = ANY($3::text[]) THEN 'released' ELSE 'cancelled' END
          WHERE tenant_id = $1 AND session_id = $2
            AND source_run_id = ANY($4::text[]) AND state IN ('pending', 'reserved')
        `, [tenantId, sessionId, releasableTaskboardSourceRunIds, selectedSourceRunIds]);
        await client.query(`
          UPDATE ${this.runsTable}
          SET status = CASE WHEN run_id = ANY($4::text[]) THEN status ELSE 'cancelled' END,
              status_reason = CASE WHEN run_id = ANY($4::text[]) THEN status_reason ELSE $5 END, updated_at = $6::timestamptz,
              cancelled_at = CASE WHEN run_id = ANY($4::text[]) THEN cancelled_at ELSE $6::timestamptz END,
              metadata = CASE WHEN run_id = ANY($4::text[]) THEN (metadata - 'steeringTargetRunId') || jsonb_build_object('steeringState', 'released')
                ELSE (metadata || jsonb_build_object('steeringState', 'cancelled')) - 'wakeMessage' END
          WHERE tenant_id = $1 AND session_id = $2 AND run_id = ANY($3::text[]) AND status = 'pending'
        `, [tenantId, sessionId, selectedSourceRunIds, releasableTaskboardSourceRunIds, reason, now]);
      }
      let toolCancelEvents: PlatformEventInput[] = [];
      if (targetRunId) {
        const targetUpdate = await client.query<{ run_id: string; cancelled_at: string | Date }>(`
          UPDATE ${this.runsTable}
          SET status = 'cancelled',
              status_reason = $4,
              updated_at = clock_timestamp(),
              cancelled_at = clock_timestamp(),
              worker_id = NULL,
              lease_expires_at = NULL,
              metadata = metadata - 'wakeMessage'
          WHERE tenant_id = $1
            AND session_id = $2
            AND run_id = $3
            AND status IN ${STOPPABLE_RUN_STATUS_SQL}
          RETURNING run_id, cancelled_at
        `, [tenantId, sessionId, targetRunId, reason]);
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
  async listPendingUserMessagesBySession(sessionId: string, tenantId = DEFAULT_TENANT_ID): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.runsTable} run
      WHERE run.tenant_id = $1
        AND run.session_id = $2
        AND run.status = 'pending'
        AND run.channel = 'web'
        AND run.metadata ? 'wakeMessage'
        AND COALESCE(run.metadata->>'backgroundTask', 'false') <> 'true'
      ORDER BY run.enqueue_seq ASC
    `, [tenantId, sessionId]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }
  async listUserMessagesBySession(sessionId: string, tenantId = DEFAULT_TENANT_ID): Promise<RunRecord[]> {
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.messageSubmissionsTable} submission
      JOIN ${this.runsTable} run
        ON run.tenant_id = submission.tenant_id
       AND run.run_id = submission.run_id
      WHERE submission.tenant_id = $1
        AND submission.session_id = $2
        AND run.channel = 'web'
        AND COALESCE(run.metadata->>'backgroundTask', 'false') <> 'true'
      ORDER BY run.enqueue_seq ASC
    `, [tenantId, sessionId]);
    return result.rows.map((row) => normalizeRunRecord(row.row_json));
  }
  async listPendingSteeringBySession(sessionId: string, tenantId = DEFAULT_TENANT_ID): Promise<SteeringInputRecord[]> {
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
      JOIN ${this.runsTable} source
        ON source.tenant_id = input.tenant_id
       AND source.session_id = input.session_id
       AND source.run_id = input.source_run_id
      WHERE input.tenant_id = $1
        AND input.session_id = $2
        AND input.state = 'pending'
        AND source.status = 'pending'
      ORDER BY input.sequence ASC
    `, [tenantId, sessionId]);
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
           idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata,
           liveness_state, liveness_detected_at, liveness_version)
        VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb,
           'active',$7,1)
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
  async markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> { return this.queries.markStatus(runId, status, reason, metadataPatch); } async activateStagedRun(runId: string): Promise<RunRecord | null> { return this.queries.activateStagedRun(runId); }
  async claimPersistedInteractionResume(runId: string, expectedStatuses: readonly RunStatus[], reason: string, metadataPatch: Record<string, unknown>): Promise<RunRecord | null> { return this.queries.claimPersistedInteractionResume(runId, expectedStatuses, reason, metadataPatch); }
  async listStagedPersistedInteractionResumes(limit?: number): Promise<RunRecord[]> { return this.queries.listStagedPersistedInteractionResumes(limit); }
  async activatePersistedInteractionResume(runId: string, claim: Record<string, unknown>, metadataPatch?: Record<string, unknown>): Promise<RunRecord | null> { return this.queries.activatePersistedInteractionResume(runId, claim, metadataPatch); }
  async rollbackPersistedInteractionResume(runId: string, claim: Record<string, unknown>, waitingStatus: 'waiting_user' | 'waiting_approval', reason?: string): Promise<RunRecord | null> { return this.queries.rollbackPersistedInteractionResume(runId, claim, waitingStatus, reason); }
  async stagePendingRun(runId: string): Promise<RunRecord | null> { return this.queries.stagePendingRun(runId); }
  async cancelPendingTaskboardRun(runId: string, reason: string): Promise<RunRecord | null> { return this.queries.cancelPendingTaskboardRun(runId, reason); }
  async claimStateOnlyTerminalOutbox(runId: string, status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'orphaned'>, reason: string | undefined, metadataPatch: Record<string, unknown>): Promise<RunRecord | null> { return this.queries.claimStateOnlyTerminalOutbox(runId, status, reason, metadataPatch); }
  async markStatusIfCurrent(runId: string, expectedStatuses: readonly RunStatus[], nextStatus: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}, leaseAuthority?: import('./runStoreTypes.js').RunLeaseAuthority): Promise<RunRecord | null> { return this.queries.markStatusIfCurrent(runId, expectedStatuses, nextStatus, reason, metadataPatch, leaseAuthority); }
  async patchMetadata(runId: string, metadataPatch: Record<string, unknown>): Promise<RunRecord | null> { return this.queries.patchMetadata(runId, metadataPatch); }
  async get(runId: string): Promise<RunRecord | null> { return this.queries.get(runId); }
  async cancelActiveByUser(userId: string, reason: string): Promise<number> { return this.queries.cancelActiveByUser(userId, reason); }
  async cancelActiveByTenant(tenantId: string, reason: string): Promise<number> { return this.queries.cancelActiveByTenant(tenantId, reason); } async listActiveByUser(userId: string): Promise<RunRecord[]> { return this.queries.listActiveByUser(userId); }
  async updateApprovalPolicyForActiveByUser(userId: string, approvalPolicy: Record<string, unknown> | null): Promise<string[]> { return this.queries.updateApprovalPolicyForActiveByUser(userId, approvalPolicy); }
  async findByIdempotencyKey(tenantId:string,userId:string|undefined,key:string):Promise<RunRecord|null>{return this.queries.findByIdempotencyKey(tenantId,userId,key);} async findUniqueByIdempotencyKeyAcrossTenants(userId:string,key:string):Promise<RunRecord|null>{return this.queries.findUniqueByIdempotencyKeyAcrossTenants(userId,key);}
  async getActiveBySession(tenantId: string, sessionId: string): Promise<RunRecord | null> { return this.queries.getActiveBySession(tenantId, sessionId); }
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
  async acquireLease(runId: string, workerId: string, leaseMs: number, now = new Date(), maxConcurrentRuns?: number, admission?: RunLeaseAdmission, identity?: RunLeaseIdentity, leaseToken?: string): Promise<RunRecord | null> {
    return this.queries.acquireLease(runId, workerId, leaseMs, now, maxConcurrentRuns, admission, identity, leaseToken);
  }
  async renewLease(runId: string, workerId: string, leaseMs: number, now = new Date(), source: RunHeartbeatSource = 'worker', leaseToken?: string): Promise<RunRecord | null> {
    return this.queries.renewLease(runId, workerId, leaseMs, now, source, leaseToken);
  }
  async heartbeatRun(runId: string, workerId: string, leaseMs: number, source: RunHeartbeatSource, now = new Date()): Promise<RunRecord | null> {
    return this.queries.renewLease(runId, workerId, leaseMs, now, source);
  }
  async markLivenessStale(runId: string, workerId: string, reasonCode: string, now = new Date()): Promise<RunRecord | null> {
    return this.queries.markLivenessStale(runId, workerId, reasonCode, now);
  }
  /** Runs one bounded, CAS-fenced liveness reaper pass. */
  async reapExpiredLiveness(now: Date, staleGraceMs: number, limit = 50): Promise<LivenessReapResult> {
    return this.queries.reapExpiredLiveness(now, staleGraceMs, limit);
  }
  async retryOrphanedUserMessage(submitterUserId: string | undefined, clientMsgId: string, now = new Date()): Promise<RunRecord | null> {
    return this.queries.retryOrphanedUserMessage(submitterUserId, clientMsgId, now);
  }
  async cancelUserMessageByClientMsgId(submitterUserId: string | undefined, clientMsgId: string, reason = 'explicit_client_cancel', now = new Date()): Promise<RunRecord | null> {
    return this.queries.cancelUserMessageByClientMsgId(submitterUserId, clientMsgId, reason, now);
  }
  async updateResponseSessionState(runId: string, tenantId: string, sessionId: string, patch: ResponseSessionStatePatch): Promise<RunRecord | null> {
    return this.queries.updateResponseSessionState(runId, tenantId, sessionId, patch);
  }
  async findLatestResponseSessionStateBySession(tenantId: string, sessionId: string, now = new Date()): Promise<LatestResponseSessionState | null> {
    return this.queries.findLatestResponseSessionStateBySession(tenantId, sessionId, now);
  }
  async clearResponseSessionStateBySession(tenantId: string, sessionId: string): Promise<number> {
    return this.queries.clearResponseSessionStateBySession(tenantId, sessionId);
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
  async releaseLease(runId: string, workerId: string, finalStatus?: RunStatus, reason?: string, options: RunLeaseReleaseOptions = {}): Promise<RunRecord | null> {
    return options.handoff ? this.queries.releaseLeaseForHandoff(runId, workerId, reason ?? 'worker_handoff', options.metadataPatch) : releaseRunLease({
      pool: this.pool,
      runsTable: this.runsTable,
      normalizeRunRecord,
    }, runId, workerId, finalStatus, reason, options.leaseToken);
  }
}
