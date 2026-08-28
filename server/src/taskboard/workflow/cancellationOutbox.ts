import type { Pool, PoolClient } from 'pg';

import type { TaskboardRuntimeTerminalFact } from '../types.js';

export const EXECUTION_TRANSITIONED_REASON = 'execution_transitioned';
const EXECUTION_TRANSITION_GRACE_MS = 30_000;
const ACTIVE_EXECUTION_STATUSES = ['queued', 'running', 'waiting_user', 'waiting_approval'];

export interface WorkflowCancellationHost {
  cancellationOutboxTable: string;
  tasksTable: string;
  executionsTable: string;
  executionOutboxTable: string;
  changesTable: string;
  pool: Pick<Pool, 'query'>;
  withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
}

async function loadCancellationForUpdate(
  host: WorkflowCancellationHost,
  client: PoolClient,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  // Global lock order: Task -> Execution -> cancellation outbox.
  const locator = await client.query(
    `SELECT execution_id,task_id FROM ${host.cancellationOutboxTable} WHERE id=$1`,
    [id],
  );
  if (!locator.rows[0]) return undefined;
  const executionId = String(locator.rows[0].execution_id);
  const taskId = String(locator.rows[0].task_id);
  const task = await client.query(
    `SELECT id FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
    [taskId],
  );
  if (!task.rows[0]) return undefined;
  const execution = await client.query(
    `SELECT id FROM ${host.executionsTable} WHERE id=$1 FOR UPDATE`,
    [executionId],
  );
  if (!execution.rows[0]) return undefined;
  const selected = await client.query(
    `SELECT o.status AS outbox_status,o.reason,o.run_id,o.execution_id,o.task_id,
            e.status AS execution_status,e.transitioned_at,e.terminal_reason_code
       FROM ${host.cancellationOutboxTable} o
       JOIN ${host.executionsTable} e ON e.id=o.execution_id
      WHERE o.id=$1 AND e.id=$2 FOR UPDATE OF o`,
    [id, executionId],
  );
  return selected.rows[0] as Record<string, unknown> | undefined;
}

export async function claimWorkflowCancellations(
  host: WorkflowCancellationHost,
  limit = 20,
): Promise<Array<{ id: string; runId: string; reason: string }>> {
  return host.withTransaction(async (client) => {
    const result = await client.query(
      `WITH due AS (
         SELECT id FROM ${host.cancellationOutboxTable}
          WHERE (status IN ('pending','failed')
             OR (status='processing' AND updated_at < now() - interval '5 minutes'))
            AND (reason<>$2 OR created_at <= now() - ($3::double precision * interval '1 millisecond'))
          ORDER BY created_at,id
          FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE ${host.cancellationOutboxTable} o
          SET status='processing',attempts=o.attempts+1,last_error=NULL,updated_at=now()
         FROM due WHERE o.id=due.id
       RETURNING o.id,o.run_id,o.reason`,
      [Math.max(1, Math.min(limit, 100)), EXECUTION_TRANSITIONED_REASON, EXECUTION_TRANSITION_GRACE_MS],
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
  if (error) {
    await host.pool.query(
      `UPDATE ${host.cancellationOutboxTable}
          SET status='failed',last_error=$2,updated_at=now()
        WHERE id=$1 AND status='processing'`,
      [id, error],
    );
    return;
  }
  await host.withTransaction(async (client) => {
    const row = await loadCancellationForUpdate(host, client, id);
    if (!row || row.outbox_status !== 'processing') return;
    if (isTransitionHandoff(row)) {
      await completeTransitionHandoff(host, client, row);
    }
    await client.query(
      `UPDATE ${host.cancellationOutboxTable}
          SET status='completed',last_error=NULL,updated_at=now()
        WHERE id=$1 AND status='processing'`,
      [id],
    );
  });
}

function isTransitionHandoff(row: Record<string, unknown>): boolean {
  const status = String(row.execution_status);
  return row.reason === EXECUTION_TRANSITIONED_REASON
    && Boolean(row.transitioned_at)
    && row.terminal_reason_code === EXECUTION_TRANSITIONED_REASON
    && (ACTIVE_EXECUTION_STATUSES.includes(status) || status === 'failed' || status === 'cancelled');
}

async function completeTransitionHandoff(
  host: WorkflowCancellationHost,
  client: PoolClient,
  row: Record<string, unknown>,
): Promise<void> {
  const updated = await client.query(
    `UPDATE ${host.executionsTable}
        SET status='succeeded',error=NULL,terminal_reason_code=NULL,superseded_at=NULL,
            finished_at=COALESCE(finished_at,now()),updated_at=now(),
            reconcile_lease_id=NULL,reconcile_lease_expires_at=NULL
      WHERE id=$1 AND transitioned_at IS NOT NULL AND terminal_reason_code=$2
      RETURNING id`,
    [String(row.execution_id), EXECUTION_TRANSITIONED_REASON],
  );
  if (!updated.rows[0]) return;
  await client.query(
    `INSERT INTO ${host.changesTable}
       (task_id,change_type,actor_type,actor_id,execution_id,payload)
     SELECT $1,'execution.handoff_completed','system',$2,$3,$4::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM ${host.changesTable}
         WHERE task_id=$1 AND change_type='execution.handoff_completed' AND execution_id=$3
      )`,
    [String(row.task_id), String(row.run_id), String(row.execution_id), JSON.stringify({
      runId: String(row.run_id), status: 'succeeded', reason: EXECUTION_TRANSITIONED_REASON,
    })],
  );
}

export async function reconcileWorkflowCancellationTerminal(
  host: WorkflowCancellationHost,
  id: string,
  fact: TaskboardRuntimeTerminalFact,
): Promise<void> {
  await host.withTransaction(async (client) => {
    const row = await loadCancellationForUpdate(host, client, id);
    if (!row) return;
    if (String(row.run_id) !== fact.runId) {
      throw new Error(`Runtime terminal fact 与 cancellation outbox 不匹配：${fact.runId}`);
    }
    if (row.outbox_status === 'completed') return;
    if (row.outbox_status !== 'processing') {
      throw new Error(`Cancellation outbox 未持有 processing lease：${id}`);
    }
    const transitionHandoff = isTransitionHandoff(row);
    const executionStatus = transitionHandoff || fact.status === 'completed' ? 'succeeded' : 'failed';
    const reason = transitionHandoff || fact.status === 'completed'
      ? null
      : fact.reason?.trim() || `Runtime 状态：${fact.status}`;
    if (transitionHandoff) {
      await completeTransitionHandoff(host, client, row);
    } else {
      await client.query(
        `UPDATE ${host.executionsTable}
            SET status=$2,error=$3,terminal_reason_code=NULL,superseded_at=NULL,
                finished_at=COALESCE(finished_at,now()),updated_at=now()
          WHERE id=$1 AND status='cancelled'`,
        [String(row.execution_id), executionStatus, reason],
      );
    }
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
