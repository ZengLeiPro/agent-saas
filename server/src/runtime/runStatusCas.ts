import type { PgPool, RunRecord, RunStatus } from './runStore.js';

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
  // Terminal statuses are sinks. Lock first and only then sample database time, so
  // row-lock waiting never shortens the lifecycle retention window.
  const result = await store.pool.query<{ row_json: RunRecord }>(`
    WITH locked AS MATERIALIZED (
      SELECT run_id
      FROM ${store.runsTable}
      WHERE run_id = $1
      FOR UPDATE
    ), transition_time AS MATERIALIZED (
      SELECT clock_timestamp() AS now FROM locked
    ), updated AS (
      UPDATE ${store.runsTable} run
      SET status = $2,
          status_reason = $3,
          updated_at = CASE
            WHEN run.status = $2 AND $2::text IN ('completed','failed','cancelled','orphaned') THEN run.updated_at
            ELSE transition_time.now
          END,
          started_at = CASE WHEN $2 = 'running' AND run.started_at IS NULL THEN transition_time.now ELSE run.started_at END,
          completed_at = CASE
            WHEN $2 = 'completed' THEN COALESCE(run.completed_at, CASE WHEN run.status = 'completed' THEN run.updated_at END, transition_time.now)
            ELSE run.completed_at
          END,
          failed_at = CASE
            WHEN $2 = 'failed' THEN COALESCE(run.failed_at, CASE WHEN run.status = 'failed' THEN run.updated_at END, transition_time.now)
            ELSE run.failed_at
          END,
          cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(run.cancelled_at, transition_time.now) ELSE run.cancelled_at END,
          metadata = CASE
            WHEN $2::text IN ('completed','failed','cancelled','orphaned')
              THEN ((run.metadata || $4::jsonb) - 'wakeMessage') || jsonb_build_object(
                'sandboxLifecycleTerminalAt', COALESCE(
                  CASE
                    WHEN run.status IN ('completed','failed','cancelled','orphaned')
                      THEN run.metadata->>'sandboxLifecycleTerminalAt'
                  END,
                  CASE
                    WHEN run.status = 'completed' THEN run.completed_at::text
                    WHEN run.status = 'failed' THEN run.failed_at::text
                    WHEN run.status = 'cancelled' THEN COALESCE(run.cancelled_at::text, run.completed_at::text, run.failed_at::text)
                    WHEN run.status = 'orphaned' THEN run.updated_at::text
                  END,
                  transition_time.now::text
                )
              )
            ELSE run.metadata || $4::jsonb
          END
      FROM transition_time
      WHERE run.run_id = $1
        AND (run.status NOT IN ('completed','failed','cancelled','orphaned') OR run.status = $2)
      RETURNING row_to_json(run.*) AS row_json
    )
    SELECT row_json FROM updated
    UNION ALL
    SELECT row_to_json(current_run.*) AS row_json
    FROM ${store.runsTable} current_run
    WHERE current_run.run_id = $1 AND NOT EXISTS (SELECT 1 FROM updated)
  `, [runId, status, reason ?? null, JSON.stringify(metadataPatch)]);
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
): Promise<RunRecord | null> {
  if (expectedStatuses.length === 0) return null;
  const result = await store.pool.query<{ row_json: RunRecord }>(`
    WITH locked AS MATERIALIZED (
      SELECT run_id
      FROM ${store.runsTable}
      WHERE run_id = $1
        AND status = ANY($2::text[])
      FOR UPDATE
    ), transition_time AS MATERIALIZED (
      SELECT clock_timestamp() AS now FROM locked
    )
    UPDATE ${store.runsTable} run
    SET status = $3,
        status_reason = $4,
        updated_at = CASE
          WHEN run.status = $3 AND $3::text IN ('completed','failed','cancelled','orphaned') THEN run.updated_at
          ELSE transition_time.now
        END,
        started_at = CASE WHEN $3 = 'running' AND run.started_at IS NULL THEN transition_time.now ELSE run.started_at END,
        completed_at = CASE
          WHEN $3 = 'completed' THEN COALESCE(run.completed_at, CASE WHEN run.status = 'completed' THEN run.updated_at END, transition_time.now)
          ELSE run.completed_at
        END,
        failed_at = CASE
          WHEN $3 = 'failed' THEN COALESCE(run.failed_at, CASE WHEN run.status = 'failed' THEN run.updated_at END, transition_time.now)
          ELSE run.failed_at
        END,
        cancelled_at = CASE WHEN $3 = 'cancelled' THEN COALESCE(run.cancelled_at, transition_time.now) ELSE run.cancelled_at END,
        metadata = CASE
          WHEN $3::text IN ('completed','failed','cancelled','orphaned')
            THEN ((run.metadata || $5::jsonb) - 'wakeMessage') || jsonb_build_object(
              'sandboxLifecycleTerminalAt', COALESCE(
                CASE
                  WHEN run.status IN ('completed','failed','cancelled','orphaned')
                    THEN run.metadata->>'sandboxLifecycleTerminalAt'
                END,
                CASE
                  WHEN run.status = 'completed' THEN run.completed_at::text
                  WHEN run.status = 'failed' THEN run.failed_at::text
                  WHEN run.status = 'cancelled' THEN COALESCE(run.cancelled_at::text, run.completed_at::text, run.failed_at::text)
                  WHEN run.status = 'orphaned' THEN run.updated_at::text
                END,
                transition_time.now::text
              )
            )
          ELSE run.metadata || $5::jsonb
        END
    FROM transition_time
    WHERE run.run_id = $1
      AND run.status = ANY($2::text[])
    RETURNING row_to_json(run.*) AS row_json
  `, [runId, [...expectedStatuses], status, reason ?? null, JSON.stringify(metadataPatch)]);
  return result.rows[0] ? store.normalizeRunRecord(result.rows[0].row_json) : null;
}
