import type { RunRecord } from './runStoreTypes.js';
import type { PgPool } from './runStoreTypes.js';
import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import { recoverableRunHandoffSql } from './runLeaseHandoff.js';

export async function getActiveRunBySession(
  pool: PgPool, runsTable: string, steeringInputsTable: string, tenantId: string, sessionId: string,
): Promise<RunRecord | null> {
  const result = await pool.query<{ row_json: RunRecord }>(`
    SELECT row_to_json(run.*) AS row_json FROM ${runsTable} run
    WHERE run.tenant_id=$1 AND run.session_id=$2
      AND run.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
      AND NOT EXISTS (
        SELECT 1 FROM ${steeringInputsTable} input
        JOIN ${runsTable} target ON target.tenant_id=input.tenant_id
          AND target.session_id=input.session_id AND target.run_id=input.target_run_id
        WHERE input.tenant_id=run.tenant_id AND input.session_id=run.session_id
          AND input.source_run_id=run.run_id AND (
            (input.state='reserved' AND target.status NOT IN ('completed','failed','cancelled','orphaned'))
            OR (input.state='pending' AND target.status IN ('pending','running','waiting_hand')
              AND COALESCE(target.metadata->>'steeringInputWindow','open')='open')
          )
      )
    ORDER BY CASE run.status WHEN 'running' THEN 0 WHEN 'waiting_approval' THEN 0
      WHEN 'waiting_user' THEN 0 WHEN 'waiting_hand' THEN 0 ELSE 1 END, run.updated_at DESC
    LIMIT 1
  `,[tenantId,sessionId]);
  return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
}

/** Subagent children are parent-owned; legacy expired rows remain recoverable while versioned M40 rows belong to the two-phase reaper. */
export async function listRecoverableRuns(
  pool: PgPool,
  runsTable: string,
  steeringInputsTable: string,
  toolInvocationsTable: string,
  now = new Date(),
): Promise<RunRecord[]> {
  const result = await pool.query<{ row_json: RunRecord }>(`
    SELECT row_to_json(run.*) AS row_json
    FROM ${runsTable} run
    WHERE (
      run.status = 'pending'
      OR (
        run.status = 'running'
        AND (run.lease_expires_at IS NULL OR run.lease_expires_at < $1)
        AND (run.liveness_version IS NULL OR run.metadata->>'backgroundTask' = 'true')
      )
      OR ${recoverableRunHandoffSql('run', toolInvocationsTable)}
    )
      AND run.metadata->>'subagent' IS DISTINCT FROM 'true'
      AND NOT (
        run.status = 'pending'
        AND COALESCE(run.metadata->>'schedulerState', '') = 'staged'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${steeringInputsTable} input
        JOIN ${runsTable} target
          ON target.tenant_id = input.tenant_id
         AND target.session_id = input.session_id
         AND target.run_id = input.target_run_id
        WHERE input.tenant_id = run.tenant_id
          AND input.session_id = run.session_id
          AND input.source_run_id = run.run_id
          AND (
            (input.state = 'reserved' AND target.status NOT IN ('completed','failed','cancelled','orphaned'))
            OR (
              input.state = 'pending'
              AND target.status IN ('pending','running','waiting_hand')
              AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open'
            )
          )
      )
    ORDER BY run.enqueue_seq ASC
  `, [now.toISOString()]);
  return result.rows.map((row) => normalizeRunRecord(row.row_json));
}
