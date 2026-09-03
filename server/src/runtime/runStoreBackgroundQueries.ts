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
