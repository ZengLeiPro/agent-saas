import type { LivenessReapResult, RunHeartbeatSource } from './runLiveness.js';
import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import type { PgPool, RunRecord } from './runStoreTypes.js';

export interface RunStoreLivenessQueryContext {
  pool: PgPool;
  runsTable: string;
  toolInvocationsTable: string;
}

export async function renewRunLease(
  context: RunStoreLivenessQueryContext,
  runId: string,
  workerId: string,
  leaseMs: number,
  now = new Date(),
  source: RunHeartbeatSource = 'worker',
  leaseToken?: string,
): Promise<RunRecord | null> {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = await context.pool.query<{ row_json: RunRecord }>(`
    UPDATE ${context.runsTable}
    SET lease_expires_at = GREATEST(COALESCE(lease_expires_at, '-infinity'::timestamptz), $3::timestamptz),
        last_heartbeat_at = GREATEST(COALESCE(last_heartbeat_at, '-infinity'::timestamptz), $4::timestamptz),
        liveness_state = 'busy',
        liveness_reason_code = $5,
        liveness_detected_at = CASE WHEN liveness_state IS DISTINCT FROM 'busy' THEN $4::timestamptz ELSE liveness_detected_at END,
        liveness_version = COALESCE(liveness_version, 0) + 1,
        updated_at = GREATEST(updated_at, $4::timestamptz)
    WHERE run_id = $1
      AND worker_id = $2
      AND ($6::text IS NULL OR metadata->>'runLeaseToken' = $6)
      AND status = 'running'
      AND liveness_state IS DISTINCT FROM 'stale'
    RETURNING row_to_json(${context.runsTable}.*) AS row_json
  `, [runId, workerId, leaseExpiresAt, now.toISOString(), `heartbeat_${source}`, leaseToken ?? null]);
  return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
}

export async function markRunLivenessStale(
  context: RunStoreLivenessQueryContext,
  runId: string,
  workerId: string,
  reasonCode: string,
  now = new Date(),
): Promise<RunRecord | null> {
  const result = await context.pool.query<{ row_json: RunRecord }>(`
    UPDATE ${context.runsTable}
    SET liveness_state = 'stale',
        liveness_reason_code = $3,
        liveness_detected_at = $4::timestamptz,
        liveness_version = COALESCE(liveness_version, 0) + 1,
        updated_at = GREATEST(updated_at, $4::timestamptz)
    WHERE run_id = $1
      AND worker_id = $2
      AND status = 'running'
      AND liveness_version IS NOT NULL
      AND liveness_state = 'busy'
    RETURNING row_to_json(${context.runsTable}.*) AS row_json
  `, [runId, workerId, reasonCode, now.toISOString()]);
  return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
}

export async function reapExpiredRunLiveness(
  context: RunStoreLivenessQueryContext,
  now: Date,
  staleGraceMs: number,
  limit = 50,
): Promise<LivenessReapResult> {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
  const staleBefore = new Date(now.getTime() - Math.max(0, staleGraceMs)).toISOString();
  const client = await context.pool.connect();
  try {
    await client.query('BEGIN');
    // Orphan first so a row made stale in this transaction cannot skip the grace phase.
    const orphaned = await client.query<{ row_json: RunRecord }>(`
      WITH candidates AS (
        SELECT run_id
        FROM ${context.runsTable}
        WHERE status = 'running'
          AND metadata->>'backgroundTask' IS DISTINCT FROM 'true'
          AND liveness_version IS NOT NULL
          AND liveness_state = 'stale'
          AND liveness_detected_at <= $1::timestamptz
        ORDER BY liveness_detected_at ASC, run_id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${context.runsTable} run
      SET status = 'orphaned',
          status_reason = CASE WHEN EXISTS (
            SELECT 1 FROM ${context.toolInvocationsTable} invocation
            WHERE invocation.run_id = run.run_id AND invocation.status = 'running'
          ) THEN 'external_tool_outcome_unknown' ELSE 'lease_expired' END,
          worker_id = NULL,
          lease_expires_at = NULL,
          liveness_state = 'orphaned',
          liveness_reason_code = CASE WHEN EXISTS (
            SELECT 1 FROM ${context.toolInvocationsTable} invocation
            WHERE invocation.run_id = run.run_id AND invocation.status = 'running'
          ) THEN 'external_tool_outcome_unknown' ELSE 'lease_expired' END,
          liveness_detected_at = $3::timestamptz,
          liveness_version = run.liveness_version + 1,
          updated_at = $3::timestamptz,
          metadata = (run.metadata || jsonb_build_object(
            'livenessTerminalizedBy', 'reaper',
            'externalToolOutcomeUnknown', EXISTS (
              SELECT 1 FROM ${context.toolInvocationsTable} invocation
              WHERE invocation.run_id = run.run_id AND invocation.status = 'running'
            )
          )) - 'wakeMessage'
      FROM candidates
      WHERE run.run_id = candidates.run_id
        AND run.status = 'running'
        AND run.metadata->>'backgroundTask' IS DISTINCT FROM 'true'
        AND run.liveness_state = 'stale'
        AND run.liveness_detected_at <= $1::timestamptz
      RETURNING row_to_json(run.*) AS row_json
    `, [staleBefore, boundedLimit, now.toISOString()]);
    const remaining = Math.max(0, boundedLimit - orphaned.rows.length);
    const stale = remaining === 0 ? { rows: [] as Array<{ row_json: RunRecord }> } : await client.query<{ row_json: RunRecord }>(`
      WITH candidates AS (
        SELECT run_id
        FROM ${context.runsTable}
        WHERE status = 'running'
          AND metadata->>'backgroundTask' IS DISTINCT FROM 'true'
          AND liveness_version IS NOT NULL
          AND liveness_state = 'busy'
          AND lease_expires_at <= $1::timestamptz
        ORDER BY lease_expires_at ASC, run_id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${context.runsTable} run
      SET liveness_state = 'stale',
          liveness_reason_code = 'lease_expired',
          liveness_detected_at = $1::timestamptz,
          liveness_version = run.liveness_version + 1,
          updated_at = $1::timestamptz
      FROM candidates
      WHERE run.run_id = candidates.run_id
        AND run.status = 'running'
        AND run.metadata->>'backgroundTask' IS DISTINCT FROM 'true'
        AND run.liveness_state = 'busy'
        AND run.lease_expires_at <= $1::timestamptz
      RETURNING row_to_json(run.*) AS row_json
    `, [now.toISOString(), remaining]);
    await client.query('COMMIT');
    return {
      stale: stale.rows.map((row) => normalizeRunRecord(row.row_json)),
      orphaned: orphaned.rows.map((row) => normalizeRunRecord(row.row_json)),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
