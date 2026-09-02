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
): Promise<RunRecord | null> {
  // Lock the owned run first; database time is sampled only after the lease owner
  // obtains the row update right, so lock waiting cannot move terminal TTL earlier.
  const result = await context.pool.query<{ row_json: RunRecord }>(`
    WITH locked AS MATERIALIZED (
      SELECT run_id
      FROM ${context.runsTable}
      WHERE run_id = $1
        AND worker_id = $2
      FOR UPDATE
    ), transition_time AS MATERIALIZED (
      SELECT clock_timestamp() AS now FROM locked
    )
    UPDATE ${context.runsTable} run
    SET status = CASE WHEN run.status IN ('completed','failed','cancelled','orphaned')
                      THEN run.status ELSE COALESCE($3, run.status) END,
        status_reason = CASE WHEN run.status IN ('completed','failed','cancelled','orphaned')
                      THEN run.status_reason ELSE COALESCE($4, run.status_reason) END,
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
        liveness_detected_at = CASE WHEN liveness_version IS NULL THEN NULL ELSE transition_time.now END,
        liveness_version = CASE WHEN liveness_version IS NULL THEN NULL ELSE liveness_version+1 END,
        updated_at = CASE WHEN run.status IN ('completed','failed','cancelled','orphaned')
                          THEN run.updated_at ELSE transition_time.now END,
        completed_at = CASE WHEN $3 = 'completed' AND run.status NOT IN ('completed','failed','cancelled','orphaned')
                            THEN transition_time.now ELSE run.completed_at END,
        failed_at = CASE WHEN $3 = 'failed' AND run.status NOT IN ('completed','failed','cancelled','orphaned')
                         THEN transition_time.now ELSE run.failed_at END,
        cancelled_at = CASE WHEN $3 = 'cancelled' AND run.status NOT IN ('completed','failed','cancelled','orphaned')
                            THEN transition_time.now ELSE run.cancelled_at END,
        metadata = CASE
          WHEN run.status IN ('completed','failed','cancelled','orphaned')
            OR $3::text IN ('completed','failed','cancelled','orphaned')
            THEN (run.metadata - 'wakeMessage') || jsonb_build_object(
              'sandboxLifecycleTerminalAt', COALESCE(
                CASE WHEN run.status IN ('completed','failed','cancelled','orphaned')
                  THEN run.metadata->>'sandboxLifecycleTerminalAt' END,
                CASE
                  WHEN run.status = 'completed' THEN run.completed_at::text
                  WHEN run.status = 'failed' THEN run.failed_at::text
                  WHEN run.status = 'cancelled' THEN COALESCE(run.cancelled_at::text, run.completed_at::text, run.failed_at::text)
                  WHEN run.status = 'orphaned' THEN run.updated_at::text
                END,
                transition_time.now::text
              )
            )
          ELSE run.metadata
        END
    FROM transition_time
    WHERE run.run_id = $1
      AND run.worker_id = $2
    RETURNING row_to_json(run.*) AS row_json
  `, [runId, workerId, finalStatus ?? null, reason ?? null]);
  return result.rows[0] ? context.normalizeRunRecord(result.rows[0].row_json) : null;
}
