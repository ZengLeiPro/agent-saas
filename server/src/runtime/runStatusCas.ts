import type { PgPool, RunLeaseAuthority, RunRecord, RunStatus } from './runStore.js';

interface RunStatusCasStore {
  pool: PgPool;
  runsTable: string;
  normalizeRunRecord(raw: unknown): RunRecord;
}

export async function markRunStatus(
  store: RunStatusCasStore,
  runId: string,
  status: RunStatus,
  reason?: string,
  metadataPatch: Record<string, unknown> = {},
): Promise<RunRecord | null> {
  const now = new Date().toISOString();
  // Terminal statuses are sinks. The CTE preserves the contract of returning the
  // current terminal record when the transition guard rejects an update.
  const result = await store.pool.query<{ row_json: RunRecord }>(`
    WITH updated AS (
      UPDATE ${store.runsTable}
      SET status = $2,
          status_reason = $3,
          updated_at = $4,
          started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN $4 ELSE started_at END,
          completed_at = CASE WHEN $2 = 'completed' THEN $4 ELSE completed_at END,
          failed_at = CASE WHEN $2 = 'failed' THEN $4 ELSE failed_at END,
          cancelled_at = CASE WHEN $2 = 'cancelled' THEN $4 ELSE cancelled_at END,
          worker_id = CASE WHEN $2::text IN ('waiting_approval','waiting_user','completed','failed','cancelled','orphaned') THEN NULL ELSE worker_id END,
          lease_expires_at = CASE WHEN $2::text IN ('waiting_approval','waiting_user','completed','failed','cancelled','orphaned') THEN NULL ELSE lease_expires_at END,
          liveness_state = CASE
            WHEN liveness_version IS NULL THEN NULL
            WHEN $2 = 'orphaned' THEN 'orphaned'
            WHEN $2::text IN ('completed','failed','cancelled') THEN 'terminal'
            WHEN $2::text IN ('waiting_approval','waiting_user') THEN 'waiting_interaction'
            WHEN $2::text IN ('running','waiting_hand') THEN 'busy'
            ELSE 'active'
          END,
          liveness_reason_code = CASE WHEN liveness_version IS NULL THEN NULL ELSE $3 END,
          liveness_detected_at = CASE WHEN liveness_version IS NULL THEN NULL ELSE $4::timestamptz END,
          liveness_version = CASE WHEN liveness_version IS NULL THEN NULL ELSE liveness_version + 1 END,
          metadata = CASE
            WHEN $2::text IN ('completed','failed','cancelled','orphaned')
              THEN (metadata || $5::jsonb) - 'wakeMessage'
            ELSE metadata || $5::jsonb
          END
      WHERE run_id = $1
        AND (status NOT IN ('completed','failed','cancelled','orphaned') OR status = $2)
      RETURNING row_to_json(${store.runsTable}.*) AS row_json
    )
    SELECT row_json FROM updated
    UNION ALL
    SELECT row_to_json(${store.runsTable}.*) AS row_json
    FROM ${store.runsTable}
    WHERE run_id = $1 AND NOT EXISTS (SELECT 1 FROM updated)
  `, [runId, status, reason ?? null, now, JSON.stringify(metadataPatch)]);
  return result.rows[0] ? store.normalizeRunRecord(result.rows[0].row_json) : null;
}

/** Atomically repairs a legacy state-only terminal row exactly once. */
export async function claimStateOnlyTerminalOutbox(
  store: RunStatusCasStore,
  runId: string,
  status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'orphaned'>,
  reason: string | undefined,
  metadataPatch: Record<string, unknown>,
): Promise<RunRecord | null> {
  const now = new Date().toISOString();
  const result = await store.pool.query<{ row_json: RunRecord }>(`
    UPDATE ${store.runsTable}
    SET status_reason = COALESCE(status_reason, $3),
        updated_at = $4,
        metadata = (metadata || $5::jsonb) - 'wakeMessage'
    WHERE run_id = $1
      AND status = $2
      AND NOT (metadata ? 'terminalEventOutbox')
    RETURNING row_to_json(${store.runsTable}.*) AS row_json
  `, [runId, status, reason ?? null, now, JSON.stringify(metadataPatch)]);
  return result.rows[0] ? store.normalizeRunRecord(result.rows[0].row_json) : null;
}

/** Implements the single-statement compare-and-set status transition for PgRunStore. */
export async function markRunStatusIfCurrent(
  store: RunStatusCasStore,
  runId: string,
  expectedStatuses: readonly RunStatus[],
  status: RunStatus,
  reason?: string,
  metadataPatch: Record<string, unknown> = {},
  leaseAuthority?: RunLeaseAuthority,
): Promise<RunRecord | null> {
  if (expectedStatuses.length === 0) return null;
  const now = new Date().toISOString();
  const result = await store.pool.query<{ row_json: RunRecord }>(`
    UPDATE ${store.runsTable}
    SET status = $3,
        status_reason = $4,
        updated_at = $5,
        started_at = CASE WHEN $3 = 'running' AND started_at IS NULL THEN $5 ELSE started_at END,
        completed_at = CASE WHEN $3 = 'completed' THEN $5 ELSE completed_at END,
        failed_at = CASE WHEN $3 = 'failed' THEN $5 ELSE failed_at END,
        cancelled_at = CASE WHEN $3 = 'cancelled' THEN $5 ELSE cancelled_at END,
        worker_id = CASE WHEN $3::text IN ('waiting_approval','waiting_user','completed','failed','cancelled','orphaned') THEN NULL ELSE worker_id END,
        lease_expires_at = CASE WHEN $3::text IN ('waiting_approval','waiting_user','completed','failed','cancelled','orphaned') THEN NULL ELSE lease_expires_at END,
        liveness_state = CASE
          WHEN liveness_version IS NULL THEN NULL
          WHEN $3 = 'orphaned' THEN 'orphaned'
          WHEN $3::text IN ('completed','failed','cancelled') THEN 'terminal'
          WHEN $3::text IN ('waiting_approval','waiting_user') THEN 'waiting_interaction'
          WHEN $3::text IN ('running','waiting_hand') THEN 'busy'
          ELSE 'active'
        END,
        liveness_reason_code = CASE WHEN liveness_version IS NULL THEN NULL ELSE $4 END,
        liveness_detected_at = CASE WHEN liveness_version IS NULL THEN NULL ELSE $5::timestamptz END,
        liveness_version = CASE WHEN liveness_version IS NULL THEN NULL ELSE liveness_version + 1 END,
        metadata = CASE
          WHEN $3::text IN ('completed','failed','cancelled','orphaned')
            THEN (metadata || $6::jsonb) - 'wakeMessage'
          ELSE metadata || $6::jsonb
        END
    WHERE run_id = $1
      AND status = ANY($2::text[])
      AND ($7::text IS NULL OR (worker_id = $7 AND metadata->>'runLeaseToken' = $8))
    RETURNING row_to_json(${store.runsTable}.*) AS row_json
  `, [runId, [...expectedStatuses], status, reason ?? null, now, JSON.stringify(metadataPatch),
    leaseAuthority?.workerId ?? null, leaseAuthority?.leaseToken ?? null]);
  return result.rows[0] ? store.normalizeRunRecord(result.rows[0].row_json) : null;
}
