import type { Pool, PoolClient } from 'pg';

export interface WorkflowCancellationHost {
  cancellationOutboxTable: string;
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
