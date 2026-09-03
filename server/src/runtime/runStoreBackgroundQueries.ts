import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import type { PgPool, RunRecord } from './runStoreTypes.js';

function boundedLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), 500);
}

export async function listPendingBackgroundTaskWakes(
  pool: PgPool,
  runsTable: string,
  staleBefore: Date,
  limit: number,
): Promise<RunRecord[]> {
  const result = await pool.query<{ row_json: RunRecord }>(
    `
    SELECT row_to_json(${runsTable}.*) AS row_json
    FROM ${runsTable}
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
  `,
    [staleBefore.toISOString(), boundedLimit(limit)],
  );
  return result.rows.map((entry) => normalizeRunRecord(entry.row_json));
}

export async function listStagedOrgAgentBackgroundTasks(
  pool: PgPool,
  runsTable: string,
  staleBefore: Date,
  limit: number,
): Promise<RunRecord[]> {
  const result = await pool.query<{ row_json: RunRecord }>(
    `
    SELECT row_to_json(${runsTable}.*) AS row_json
    FROM ${runsTable}
    WHERE metadata->>'backgroundTask'='true'
      AND metadata->>'backgroundTaskVersion'='2'
      AND COALESCE(metadata->>'backgroundTaskReady','false')='false'
      AND metadata->'orgAgentChannel' IS NOT NULL
      AND status='pending' AND updated_at<$1
    ORDER BY updated_at,run_id LIMIT $2
  `,
    [staleBefore.toISOString(), boundedLimit(limit)],
  );
  return result.rows.map((entry) => normalizeRunRecord(entry.row_json));
}

export async function activateStagedOrgAgentBackgroundTask(
  pool: PgPool,
  runsTable: string,
  runId: string,
  reason: string,
  metadataPatch: Record<string, unknown>,
): Promise<RunRecord | null> {
  const now = new Date().toISOString();
  const result = await pool.query<{ row_json: RunRecord }>(
    `UPDATE ${runsTable}
    SET status_reason=$2,updated_at=$3,
        metadata=metadata || $4::jsonb || jsonb_build_object('backgroundTaskReady',true)
    WHERE run_id=$1 AND status='pending'
      AND metadata->>'backgroundTask'='true'
      AND metadata->>'backgroundTaskVersion'='2'
      AND COALESCE(metadata->>'backgroundTaskReady','false')='false'
      AND metadata->'orgAgentChannel' IS NOT NULL
    RETURNING row_to_json(${runsTable}.*) AS row_json`,
    [runId, reason, now, JSON.stringify(metadataPatch)],
  );
  return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
}

export async function claimBackgroundTaskWake(
  pool: PgPool,
  runsTable: string,
  runId: string,
  claimToken: string,
  staleBefore: Date,
): Promise<RunRecord | null> {
  const now = new Date().toISOString();
  const patch = JSON.stringify({ wakeState: 'delivering', wakeClaimToken: claimToken,
    wakeClaimedAt: now });
  const result = await pool.query<{ row_json: RunRecord }>(`
    UPDATE ${runsTable} SET metadata=metadata || $4::jsonb,updated_at=$5
    WHERE run_id=$1 AND length($2::text)>0 AND metadata->>'backgroundTask'='true'
      AND status IN ('completed','failed','cancelled','orphaned') AND (
        COALESCE(metadata->>'wakeState','pending')='pending' OR (
          metadata->>'wakeState'='delivering'
          AND COALESCE((metadata->>'wakeClaimedAt')::timestamptz,'-infinity'::timestamptz)<$3
        )
      ) RETURNING row_to_json(${runsTable}.*) AS row_json
  `, [runId, claimToken, staleBefore.toISOString(), patch, now]);
  return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
}

export async function finishBackgroundTaskWake(
  pool: PgPool,
  runsTable: string,
  runId: string,
  claimToken: string,
  state: 'pending' | 'queued' | 'discarded',
  metadataPatch: Record<string, unknown>,
): Promise<RunRecord | null> {
  const now = new Date().toISOString();
  const patch = JSON.stringify({ ...metadataPatch, wakeState: state, wakeFinishedAt: now,
    wakeClaimToken: null });
  const result = await pool.query<{ row_json: RunRecord }>(`
    UPDATE ${runsTable} SET metadata=metadata || $4::jsonb,updated_at=$5
    WHERE run_id=$1 AND metadata->>'wakeState'='delivering'
      AND metadata->>'wakeClaimToken'=$2 AND $3::text IN ('pending','queued','discarded')
    RETURNING row_to_json(${runsTable}.*) AS row_json
  `, [runId, claimToken, state, patch, now]);
  return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
}
