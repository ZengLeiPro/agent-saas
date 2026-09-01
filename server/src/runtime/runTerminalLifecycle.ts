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
        updated_at = CASE WHEN status IN ('completed','failed','cancelled','orphaned') THEN updated_at ELSE $5 END,
        completed_at = CASE WHEN $3 = 'completed' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE completed_at END,
        failed_at = CASE WHEN $3 = 'failed' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE failed_at END,
        cancelled_at = CASE WHEN $3 = 'cancelled' AND status NOT IN ('completed','failed','cancelled','orphaned') THEN $5 ELSE cancelled_at END,
        metadata = CASE
          WHEN status IN ('completed','failed','cancelled','orphaned')
            OR $3::text IN ('completed','failed','cancelled','orphaned')
            THEN (metadata - 'wakeMessage') || jsonb_build_object(
              'sandboxLifecycleTerminalAt', COALESCE(
                CASE WHEN status IN ('completed','failed','cancelled','orphaned')
                  THEN metadata->>'sandboxLifecycleTerminalAt' END,
                CASE
                  WHEN status = 'completed' THEN completed_at::text
                  WHEN status = 'failed' THEN failed_at::text
                  WHEN status = 'cancelled' THEN COALESCE(cancelled_at::text, completed_at::text, failed_at::text)
                  WHEN status = 'orphaned' THEN updated_at::text
                END,
                $5::text
              )
            )
          ELSE metadata
        END
    WHERE run_id = $1
      AND worker_id = $2
    RETURNING row_to_json(${context.runsTable}.*) AS row_json
  `, [runId, workerId, finalStatus ?? null, reason ?? null, now]);
  return result.rows[0] ? context.normalizeRunRecord(result.rows[0].row_json) : null;
}
