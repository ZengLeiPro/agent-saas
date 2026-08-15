import type { Pool, QueryResultRow } from 'pg';

import type { ToolInvocationRecord, ToolInvocationRunGateResult } from './toolInvocationStore.js';

interface PgToolInvocationRunGateOptions<TRow> {
  pool: Pool;
  runsTable: string;
  toolInvocationsTable: string;
  rowToRecord: (row: TRow) => ToolInvocationRecord;
}

/**
 * 在 run → invocation 行锁下原子取得唯一执行权。只有 claim 提交成功后才调用工具：
 * 终态先提交则 fail closed；claim 先提交则 invocation 已权威进入执行，后续 stop
 * 按运行中工具取消语义处理；事务提交失败时绝不产生外部副作用。
 */
export async function invokeWithPgActiveRunGate<T, TRow extends QueryResultRow>(
  options: PgToolInvocationRunGateOptions<TRow>,
  runId: string,
  invocationId: string,
  invoke: () => Promise<T>,
): Promise<ToolInvocationRunGateResult<T>> {
  const client = await options.pool.connect();
  let claimed = false;
  try {
    await client.query('BEGIN');
    const run = await client.query<{ status: string }>(`
      SELECT status FROM ${options.runsTable} WHERE run_id = $1 FOR SHARE
    `, [runId]);
    const runStatus = run.rows[0]?.status;
    const invocationResult = await client.query<TRow>(`
      SELECT * FROM ${options.toolInvocationsTable}
      WHERE invocation_id = $1 AND run_id = $2
      FOR UPDATE
    `, [invocationId, runId]);
    const invocation = invocationResult.rows[0] ? options.rowToRecord(invocationResult.rows[0]) : null;
    let blocked: ToolInvocationRunGateResult<T> | undefined;
    if (!invocation) {
      blocked = { invoked: false, reason: 'invocation_missing', invocation: null };
    } else if (typeof invocation.metadata.invokeClaimedAt === 'string') {
      blocked = { invoked: false, reason: 'invocation_claimed', invocation };
    } else if (!runStatus) {
      blocked = { invoked: false, reason: 'run_missing', invocation };
    } else if (['completed', 'failed', 'cancelled', 'orphaned'].includes(runStatus)) {
      blocked = { invoked: false, reason: 'run_terminal', invocation, runStatus };
    } else if (invocation.status !== 'running') {
      blocked = { invoked: false, reason: 'invocation_terminal', invocation };
    } else if (invocation.cancelRequestedAt) {
      blocked = { invoked: false, reason: 'cancel_requested', invocation };
    }
    if (blocked) {
      await client.query('COMMIT');
      return blocked;
    }

    const claim = await client.query<TRow>(`
      UPDATE ${options.toolInvocationsTable}
      SET updated_at = clock_timestamp(),
          metadata = metadata || jsonb_build_object('invokeClaimedAt', clock_timestamp())
      WHERE invocation_id = $1
        AND run_id = $2
        AND status = 'running'
        AND cancel_requested_at IS NULL
        AND NOT (metadata ? 'invokeClaimedAt')
      RETURNING *
    `, [invocationId, runId]);
    if (!claim.rows[0]) {
      await client.query('ROLLBACK');
      return { invoked: false, reason: 'invocation_claimed', invocation };
    }
    await client.query('COMMIT');
    claimed = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (!claimed) throw new Error(`Failed to claim tool invocation ${invocationId}`);
  return { invoked: true, result: await invoke() };
}
