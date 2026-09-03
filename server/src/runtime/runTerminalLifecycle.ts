import pg from 'pg';

import type { RunRecord, RunStatus } from './runStore.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

interface RunTerminalLifecycleContext {
  pool: PgPool;
  runsTable: string;
  normalizeRunRecord: (raw: unknown) => RunRecord;
}

export async function cancelActiveRunsByUser(
  context: Pick<RunTerminalLifecycleContext, 'pool' | 'runsTable'>,
  userId: string,
  reason: string,
): Promise<number> {
  const now = new Date().toISOString();
  const result = await context.pool.query(`
    UPDATE ${context.runsTable}
    SET status='cancelled',
        status_reason=$2,
        cancelled_at=COALESCE(cancelled_at,$3::timestamptz),
        updated_at=$3::timestamptz,
        worker_id=NULL,
        lease_expires_at=NULL,
        liveness_state=CASE WHEN liveness_version IS NULL THEN NULL ELSE 'terminal' END,
        liveness_reason_code=CASE WHEN liveness_version IS NULL THEN NULL ELSE $2 END,
        liveness_detected_at=CASE WHEN liveness_version IS NULL THEN NULL ELSE $3::timestamptz END,
        liveness_version=CASE WHEN liveness_version IS NULL THEN NULL ELSE liveness_version+1 END,
        metadata=(metadata || jsonb_build_object('cancelSource','user_offboarding')) - 'wakeMessage'
    WHERE user_id=$1
      AND status NOT IN ('completed','failed','cancelled','orphaned')
    RETURNING run_id
  `, [userId, reason, now]);
  return result.rowCount ?? 0;
}

export async function releaseRunLease(
  context: RunTerminalLifecycleContext,
  runId: string,
  workerId: string,
  finalStatus?: RunStatus,
  reason?: string,
  leaseToken?: string,
): Promise<RunRecord | null> {
  const now = new Date().toISOString();
  // Terminal status is a sink. The lease owner always clears worker/expiry, but
  // an already-terminal run keeps its status, reason, and terminal timestamps.
  const result = await context.pool.query<{ row_json: RunRecord }>(`
    UPDATE ${context.runsTable}
    SET status = CASE WHEN status IN ('completed','failed','cancelled','orphaned')
                      THEN status ELSE COALESCE($3, status) END,
        status_reason = CASE WHEN status IN ('completed','failed','cancelled','orphaned')
                      THEN status_reason ELSE COALESCE($4, status_reason) END,
        worker_id = NULL,
        lease_expires_at = NULL,
        liveness_state = CASE
          WHEN liveness_version IS NULL THEN NULL
          WHEN status = 'orphaned' OR $3 = 'orphaned' THEN 'orphaned'
          WHEN status IN ('completed','failed','cancelled') OR $3::text IN ('completed','failed','cancelled') THEN 'terminal'
          WHEN $3::text IN ('waiting_approval','waiting_user') THEN 'waiting_interaction'
          WHEN $3 IS NULL AND status IN ('running','waiting_hand') THEN 'stale'
          WHEN COALESCE($3,status)::text IN ('running','waiting_hand') THEN 'busy'
          ELSE 'active'
        END,
        liveness_reason_code = CASE WHEN liveness_version IS NULL THEN NULL ELSE COALESCE($4, CASE WHEN $3 IS NULL THEN 'worker_released' ELSE status_reason END) END,
        liveness_detected_at = CASE WHEN liveness_version IS NULL THEN NULL ELSE $5::timestamptz END,
        liveness_version = CASE WHEN liveness_version IS NULL THEN NULL ELSE liveness_version+1 END,
        updated_at = $5,
        completed_at = CASE WHEN $3 = 'completed' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE completed_at END,
        failed_at = CASE WHEN $3 = 'failed' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE failed_at END,
        cancelled_at = CASE WHEN $3 = 'cancelled' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE cancelled_at END,
        metadata = CASE
          WHEN status IN ('completed','failed','cancelled','orphaned')
            OR $3::text IN ('completed','failed','cancelled','orphaned')
            THEN metadata - 'wakeMessage'
          ELSE metadata
        END
    WHERE run_id = $1
      AND worker_id = $2
      AND ($6::text IS NULL OR metadata->>'runLeaseToken' = $6)
    RETURNING row_to_json(${context.runsTable}.*) AS row_json
  `, [runId, workerId, finalStatus ?? null, reason ?? null, now, leaseToken ?? null]);
  return result.rows[0] ? context.normalizeRunRecord(result.rows[0].row_json) : null;
}
