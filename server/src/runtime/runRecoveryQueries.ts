import type { PgPool, RunRecord } from './runStoreTypes.js';
import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import { recoverableRunHandoffSql } from './runLeaseHandoff.js';

export async function listRecoverableRuns(input: {
  pool: PgPool;
  runsTable: string;
  steeringInputsTable: string;
  toolInvocationsTable: string;
  now: Date;
}): Promise<RunRecord[]> {
  const result = await input.pool.query<{ row_json: RunRecord }>(
    `
    SELECT row_to_json(run.*) AS row_json
    FROM ${input.runsTable} run
    WHERE (
      run.status = 'pending'
      OR (run.status = 'running' AND run.liveness_version IS NULL
        AND (run.lease_expires_at IS NULL OR run.lease_expires_at < $1))
      OR ${recoverableRunHandoffSql('run', input.toolInvocationsTable)}
    )
      AND NOT (run.status = 'pending'
        AND COALESCE(run.metadata->>'schedulerState', '') = 'staged')
      AND NOT EXISTS (
        SELECT 1 FROM ${input.steeringInputsTable} input
        JOIN ${input.runsTable} target ON target.run_id = input.target_run_id
        WHERE input.source_run_id = run.run_id AND (
          (input.state = 'reserved'
            AND target.status NOT IN ('completed','failed','cancelled','orphaned'))
          OR (input.state = 'pending'
            AND target.status IN ('pending','running','waiting_hand')
            AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open')
        )
      )
    ORDER BY run.enqueue_seq ASC
  `,
    [input.now.toISOString()],
  );
  return result.rows.map((row) => normalizeRunRecord(row.row_json));
}
