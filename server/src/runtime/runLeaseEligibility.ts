/**
 * Run 领取前的数据库级阻断条件。调度器 CAS 与队列告警共用同一段 SQL，
 * 避免告警把实际不可领取的队尾、活跃会话或 steering source 当成平台阻塞。
 */
export function runLeaseBlockersClearedSql(
  candidateAlias: 'candidate',
  runsTable: string,
  steeringInputsTable: string,
): string {
  return `(
    ${candidateAlias}.status <> 'pending'
    OR NOT EXISTS (
      SELECT 1
      FROM ${runsTable} predecessor
      WHERE predecessor.tenant_id = ${candidateAlias}.tenant_id
        AND predecessor.session_id = ${candidateAlias}.session_id
        AND predecessor.status = 'pending'
        AND predecessor.run_id <> ${candidateAlias}.run_id
        AND predecessor.enqueue_seq < ${candidateAlias}.enqueue_seq
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM ${runsTable} active
    WHERE active.tenant_id = ${candidateAlias}.tenant_id
      AND active.session_id = ${candidateAlias}.session_id
      AND active.run_id <> ${candidateAlias}.run_id
      AND active.status IN ('running','waiting_hand')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM ${steeringInputsTable} input
    JOIN ${runsTable} target
      ON target.tenant_id = input.tenant_id
     AND target.session_id = input.session_id
     AND target.run_id = input.target_run_id
    WHERE input.tenant_id = ${candidateAlias}.tenant_id
      AND input.session_id = ${candidateAlias}.session_id
      AND input.source_run_id = ${candidateAlias}.run_id
      AND (
        (input.state = 'reserved' AND target.status NOT IN ('completed','failed','cancelled','orphaned'))
        OR (input.state = 'pending' AND target.status IN ('pending','running','waiting_hand')
          AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open')
      )
  )`;
}
