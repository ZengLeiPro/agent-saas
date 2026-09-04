import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import type { PgPool, RunRecord } from './runStoreTypes.js';

const LEGACY_HANDOFF_REASONS = [
  'server_drain_handoff',
  'session_busy',
  'background_command_monitor_handoff',
] as const;

export interface RunLeaseHandoffContext {
  pool: PgPool;
  runsTable: string;
  toolInvocationsTable: string;
}

/**
 * 新版本用 version-null 兼容桥，保证回滚后的 N 版本 Worker 仍能领取交接任务。
 * stale 分支只接受排空中的 N-1 Worker 已经写入的精确原因标记。
 */
export function recoverableRunHandoffSql(runAlias: string, toolInvocationsTable: string): string {
  const legacyReasons = LEGACY_HANDOFF_REASONS.map((reason) => `'${reason}'`).join(',');
  return `(
    ${runAlias}.status = 'running'
    AND ${runAlias}.worker_id IS NULL
    AND ${runAlias}.lease_expires_at IS NULL
    AND (
      (
        ${runAlias}.liveness_version IS NULL
        AND ${runAlias}.metadata->>'drainHandoffReady' = 'true'
      )
      OR (
        ${runAlias}.liveness_state = 'stale'
        AND (
          ${runAlias}.liveness_reason_code IN (${legacyReasons})
          OR (
            ${runAlias}.metadata ? 'drainHandoffAt'
            AND ${runAlias}.liveness_reason_code LIKE 'steering\\_%' ESCAPE '\\'
          )
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${toolInvocationsTable} handoff_invocation
      WHERE handoff_invocation.run_id = ${runAlias}.run_id
        AND handoff_invocation.status = 'running'
    )
  )`;
}

/** owner-fenced 主动交接；外部工具结果未知时 fail closed，不允许重放。 */
export async function releaseRunLeaseForHandoff(
  context: RunLeaseHandoffContext,
  runId: string,
  workerId: string,
  reason: string,
  metadataPatch: Record<string, unknown> = {},
): Promise<RunRecord | null> {
  const client = await context.pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `
      SELECT run_id FROM ${context.runsTable}
      WHERE run_id = $1 AND worker_id = $2 AND status = 'running'
        AND lease_expires_at > clock_timestamp()
        AND (liveness_version IS NULL OR liveness_state = 'busy')
      FOR UPDATE
    `,
      [runId, workerId],
    );
    if (!locked.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const result = await client.query<{ row_json: RunRecord }>(
      `
      WITH transition_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
      UPDATE ${context.runsTable} run
      SET status_reason = $3, worker_id = NULL, lease_expires_at = NULL,
          liveness_state = NULL, liveness_reason_code = NULL, liveness_detected_at = NULL,
          liveness_version = NULL, updated_at = transition_time.now,
          metadata = run.metadata || $4::jsonb || jsonb_build_object('drainHandoffReady', true)
      FROM transition_time
      WHERE run.run_id = $1 AND run.worker_id = $2 AND run.status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM ${context.toolInvocationsTable} invocation
          WHERE invocation.run_id = run.run_id AND invocation.status = 'running'
        )
      RETURNING row_to_json(run.*) AS row_json
    `,
      [runId, workerId, reason, JSON.stringify(metadataPatch)],
    );
    await client.query('COMMIT');
    return result.rows[0] ? normalizeRunRecord(result.rows[0].row_json) : null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
