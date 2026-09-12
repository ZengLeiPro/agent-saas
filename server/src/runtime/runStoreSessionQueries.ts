import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import type { PgPool, RunRecord } from './runStoreTypes.js';

export async function listRunsBySession(
  pool: PgPool,
  runsTable: string,
  sessionId: string,
  options: { limit?: number; beforeUpdatedAt?: string } = {},
): Promise<RunRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const result = await pool.query<{ row_json: RunRecord }>(
    `
    SELECT row_to_json(${runsTable}.*) AS row_json
    FROM ${runsTable}
    WHERE session_id = $1
      AND COALESCE(metadata->>'sandboxCleanupCarrier', 'false') <> 'true'
      AND ($2::timestamptz IS NULL OR updated_at < $2::timestamptz)
    ORDER BY updated_at DESC
    LIMIT $3
  `,
    [sessionId, options.beforeUpdatedAt ?? null, limit],
  );
  return result.rows.map((row) => normalizeRunRecord(row.row_json));
}
