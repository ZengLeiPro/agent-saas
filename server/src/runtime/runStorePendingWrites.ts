import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import { RunCreateConflictError } from './runStoreTypes.js';
import type { PgPool, RunRecord, UpsertRunInput } from './runStoreTypes.js';

export async function upsertPendingRun(
  pool: PgPool,
  runsTable: string,
  input: UpsertRunInput,
): Promise<RunRecord> {
  const now = new Date().toISOString();
  const result = await pool.query<{ row_json: RunRecord }>(
    `
    INSERT INTO ${runsTable}
      (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at, idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata,
       liveness_state, liveness_detected_at, liveness_version)
    VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb,
       'active',$7,1)
    ON CONFLICT (run_id) DO UPDATE SET
      updated_at = EXCLUDED.updated_at,
      status = CASE WHEN ${runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                    THEN 'pending' ELSE ${runsTable}.status END,
      status_reason = CASE WHEN ${runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                           THEN NULL ELSE ${runsTable}.status_reason END,
      worker_id = CASE WHEN ${runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                       THEN NULL ELSE ${runsTable}.worker_id END,
      lease_expires_at = CASE WHEN ${runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                              THEN NULL ELSE ${runsTable}.lease_expires_at END,
      liveness_state = CASE WHEN ${runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                            THEN 'active' ELSE ${runsTable}.liveness_state END,
      liveness_reason_code = CASE WHEN ${runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                                  THEN NULL ELSE ${runsTable}.liveness_reason_code END,
      liveness_detected_at = CASE WHEN ${runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                                   THEN EXCLUDED.updated_at ELSE ${runsTable}.liveness_detected_at END,
      liveness_version = CASE WHEN ${runsTable}.status IN ('waiting_approval','waiting_user','waiting_hand')
                               THEN COALESCE(${runsTable}.liveness_version,0)+1 ELSE ${runsTable}.liveness_version END,
      model = CASE WHEN ${runsTable}.metadata->>'subagentContinuationClaim' = 'true'
                   THEN EXCLUDED.model ELSE ${runsTable}.model END,
      sandbox_scope_id = COALESCE(EXCLUDED.sandbox_scope_id, ${runsTable}.sandbox_scope_id),
      submitter_scope = COALESCE(EXCLUDED.submitter_scope, ${runsTable}.submitter_scope),
      metadata = (${runsTable}.metadata - 'subagentContinuationClaim') || EXCLUDED.metadata
    RETURNING row_to_json(${runsTable}.*) AS row_json
  `,
    [
      input.runId,
      input.sessionId,
      input.userId ?? null,
      input.tenantId ?? null,
      input.model ?? null,
      input.channel ?? null,
      now,
      input.idempotencyKey ?? null,
      input.executionTarget ?? null,
      input.workspaceId ?? null,
      input.sandboxScopeId ?? null,
      input.submitterUserId ?? input.userId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return normalizeRunRecord(result.rows[0]!.row_json);
}

export async function createPendingRun(
  pool: PgPool,
  runsTable: string,
  input: UpsertRunInput,
): Promise<{ record: RunRecord; created: boolean }> {
  const now = new Date().toISOString();
  let result: { rows: Array<{ row_json: RunRecord }> };
  try {
    result = await pool.query<{ row_json: RunRecord }>(
      `
      INSERT INTO ${runsTable}
        (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at, idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata,
         liveness_state, liveness_detected_at, liveness_version)
      VALUES ($1,$2,$3,COALESCE($4,'${DEFAULT_TENANT_ID}'),'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb,
         'active',$7,1)
      ON CONFLICT (run_id) DO NOTHING
      RETURNING row_to_json(${runsTable}.*) AS row_json
    `,
      [
        input.runId,
        input.sessionId,
        input.userId ?? null,
        input.tenantId ?? null,
        input.model ?? null,
        input.channel ?? null,
        now,
        input.idempotencyKey ?? null,
        input.executionTarget ?? null,
        input.workspaceId ?? null,
        input.sandboxScopeId ?? null,
        input.submitterUserId ?? input.userId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === '23505') {
      throw new RunCreateConflictError(`Run create-only idempotency conflict: ${input.runId}`);
    }
    throw error;
  }
  if (result.rows[0]) return { record: normalizeRunRecord(result.rows[0].row_json), created: true };
  const existing = await pool.query<{ row_json: RunRecord }>(
    `
    SELECT row_to_json(run.*) AS row_json FROM ${runsTable} run WHERE run_id = $1
  `,
    [input.runId],
  );
  if (!existing.rows[0]) throw new Error(`Run create-only conflict disappeared: ${input.runId}`);
  return { record: normalizeRunRecord(existing.rows[0].row_json), created: false };
}
