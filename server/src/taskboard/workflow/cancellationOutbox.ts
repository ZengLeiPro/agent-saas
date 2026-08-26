import type { Pool, PoolClient } from 'pg';

import type { TaskboardRuntimeTerminalFact } from '../types.js';

export interface WorkflowCancellationHost {
  cancellationOutboxTable: string;
  executionsTable: string;
  executionOutboxTable: string;
  changesTable: string;
  pool: Pick<Pool, 'query'>;
  withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
}

export async function claimWorkflowCancellations(
  host: WorkflowCancellationHost,
  limit = 20,
): Promise<Array<{ id: string; runId: string; reason: string }>> {
  return host.withTransaction(async (client) => {
    const result = await client.query(
      `WITH due AS (
         SELECT id FROM ${host.cancellationOutboxTable}
          WHERE status IN ('pending','failed')
             OR (status='processing' AND updated_at < now() - interval '5 minutes')
          ORDER BY created_at,id
          FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE ${host.cancellationOutboxTable} o
          SET status='processing',attempts=o.attempts+1,last_error=NULL,updated_at=now()
         FROM due WHERE o.id=due.id
       RETURNING o.id,o.run_id,o.reason`,
      [Math.max(1, Math.min(limit, 100))],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      reason: String(row.reason),
    }));
  });
}

export async function finishWorkflowCancellation(
  host: WorkflowCancellationHost,
  id: string,
  error?: string,
): Promise<void> {
  await host.pool.query(
    `UPDATE ${host.cancellationOutboxTable}
        SET status=$2,last_error=$3,updated_at=now()
      WHERE id=$1 AND status='processing'`,
    [id, error ? 'failed' : 'completed', error ?? null],
  );
}

export async function reconcileWorkflowCancellationTerminal(
  host: WorkflowCancellationHost,
  id: string,
  fact: TaskboardRuntimeTerminalFact,
): Promise<void> {
  await host.withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT o.run_id,o.execution_id,o.task_id,o.status AS outbox_status,e.status AS execution_status
         FROM ${host.cancellationOutboxTable} o
         JOIN ${host.executionsTable} e ON e.id=o.execution_id
        WHERE o.id=$1 FOR UPDATE OF o,e`,
      [id],
    );
    const row = selected.rows[0];
    if (!row) return;
    if (String(row.run_id) !== fact.runId) {
      throw new Error(`Runtime terminal fact 与 cancellation outbox 不匹配：${fact.runId}`);
    }
    if (row.outbox_status === 'completed') return;
    if (row.outbox_status !== 'processing') {
      throw new Error(`Cancellation outbox 未持有 processing lease：${id}`);
    }
    const executionStatus = fact.status === 'completed' ? 'succeeded' : 'failed';
    const reason = fact.status === 'completed'
      ? null
      : fact.reason?.trim() || `Runtime 状态：${fact.status}`;
    await client.query(
      `UPDATE ${host.executionsTable}
          SET status=$2,error=$3,terminal_reason_code=NULL,superseded_at=NULL,
              finished_at=COALESCE(finished_at,now()),updated_at=now()
        WHERE id=$1 AND status='cancelled'`,
      [String(row.execution_id), executionStatus, reason],
    );
    await client.query(
      `UPDATE ${host.executionOutboxTable}
          SET status='dispatched',lease_id=NULL,lease_expires_at=NULL,last_error=NULL,
              dispatched_at=COALESCE(dispatched_at,now()),updated_at=now()
        WHERE run_id=$1 AND status<>'dispatched'`,
      [fact.runId],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id,change_type,actor_type,actor_id,execution_id,payload)
       SELECT $1,'execution.terminal_reconciled','system',$2,$3,$4::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM ${host.changesTable}
           WHERE task_id=$1 AND change_type='execution.terminal_reconciled' AND actor_id=$2
        )`,
      [String(row.task_id), id, String(row.execution_id), JSON.stringify({
        runId: fact.runId,
        runtimeStatus: fact.status,
        executionStatus,
        reason,
      })],
    );
    await client.query(
      `UPDATE ${host.cancellationOutboxTable}
          SET status='completed',last_error=NULL,updated_at=now()
        WHERE id=$1`,
      [id],
    );
  });
}
