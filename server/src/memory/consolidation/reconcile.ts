import type { PoolClient } from 'pg';

/** 与 claim 同一事务运行；只修复调度元数据，不伪造 run_finished 或业务成功。 */
export async function reconcileConsolidationState(
  client: PoolClient,
  prefix: string,
  now: string,
  debounceMinutes: number,
): Promise<void> {
  const state = `${prefix}_memory_consolidation_state`;
  const runs = `${prefix}_runs`;
  const ledger = `${prefix}_memory_consolidation_runs`;
  const tools = `${prefix}_tool_invocations`;
  await client.query(
    `
    WITH candidates AS MATERIALIZED (
      SELECT s.tenant_id, s.session_id, stale.ids, stale.finished_at, stale.target_sequence
      FROM ${state} s
      CROSS JOIN LATERAL (
        SELECT jsonb_agg(r.run_id) AS ids, MAX(r.updated_at) AS finished_at,
          MAX((SELECT MAX(e.session_sequence) FROM ${prefix}_events e
            WHERE e.tenant_id = r.tenant_id AND e.session_id = r.session_id AND e.run_id = r.run_id)) AS target_sequence
        FROM jsonb_array_elements_text(s.active_run_ids) a(run_id)
        JOIN ${runs} r ON r.run_id = a.run_id
          AND r.tenant_id = s.tenant_id AND r.session_id = s.session_id
          AND r.user_id = s.user_id
        WHERE r.status IN ('completed', 'failed', 'cancelled', 'orphaned')
          AND (r.lease_expires_at IS NULL OR r.lease_expires_at < $1::timestamptz)
          AND (r.status <> 'orphaned' OR (
            r.liveness_reason_code IS DISTINCT FROM 'external_tool_outcome_unknown'
            AND COALESCE(r.metadata->>'externalToolOutcomeUnknown', 'false') <> 'true'
          ))
          AND NOT EXISTS (SELECT 1 FROM ${tools} t
            WHERE t.tenant_id = r.tenant_id AND t.run_id = r.run_id AND t.status = 'running')
      ) stale
      WHERE stale.ids IS NOT NULL
        AND (s.lease_expires_at IS NULL OR s.lease_expires_at < $1::timestamptz)
        AND s.status <> 'running'
      ORDER BY s.updated_at
      LIMIT 100 FOR UPDATE OF s SKIP LOCKED
    )
    UPDATE ${state} s SET
      active_run_ids = COALESCE((SELECT jsonb_agg(a.id)
        FROM jsonb_array_elements_text(s.active_run_ids) a(id)
        WHERE NOT (c.ids ? a.id)), '[]'::jsonb),
      target_session_sequence = GREATEST(s.target_session_sequence, c.target_sequence),
      status = CASE WHEN s.status = 'idle'
        AND GREATEST(s.target_session_sequence, c.target_sequence) > s.processed_session_sequence
        THEN 'pending' ELSE s.status END,
      first_pending_at = CASE WHEN GREATEST(s.target_session_sequence, c.target_sequence) > s.processed_session_sequence
        THEN COALESCE(s.first_pending_at, c.finished_at) ELSE s.first_pending_at END,
      due_at = GREATEST(COALESCE(s.due_at, c.finished_at),
        c.finished_at + make_interval(mins => $2)),
      updated_at = $1::timestamptz
    FROM candidates c WHERE s.tenant_id = c.tenant_id AND s.session_id = c.session_id
  `,
    [now, debounceMinutes],
  );

  // 已被处理水位覆盖的 started 不是成功；保留为明确的 superseded 失败记录。
  // prepared 和任何带恢复 journal 的记录必须留给文件恢复流程。
  await client.query(
    `
    WITH obsolete AS (
      SELECT l.id FROM ${ledger} l JOIN ${state} s
        ON s.tenant_id = l.tenant_id AND s.session_id = l.session_id
      WHERE l.status = 'started' AND l.to_session_sequence <= s.processed_session_sequence
        AND NOT COALESCE(l.usage_json ? 'commitJournal', FALSE)
        AND (s.lease_expires_at IS NULL OR s.lease_expires_at < $1::timestamptz)
      ORDER BY l.updated_at LIMIT 100 FOR UPDATE OF l SKIP LOCKED
    )
    UPDATE ${ledger} l SET status = 'permanent_failed',
      error_code = 'superseded_by_processed_watermark',
      error_message = '处理水位已覆盖该范围，关闭遗留 started 记录；不代表本次执行成功',
      finished_at = $1::timestamptz, updated_at = $1::timestamptz
    FROM obsolete o WHERE l.id = o.id
  `,
    [now],
  );
}
