import type { Pool, PoolClient } from 'pg';

import { requireText } from './storeHelpers.js';
import type {
  TaskboardContinuationDispatch,
  TaskboardContinuationDispatchPayload,
  TaskboardContinuationReconcileCandidate,
} from './types.js';

export interface TaskboardContinuationOutboxHost {
  pool: Pool;
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  continuationOutboxTable: string;
}

class PartialContinuationClaimError extends Error {}

export function continuationOutboxTableSql(
  table: string,
  tasksTable: string,
  commentsTable: string,
): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES ${tasksTable}(id),
    comment_id TEXT NOT NULL REFERENCES ${commentsTable}(id),
    session_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'dispatching', 'dispatched', 'completed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_id TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error TEXT,
    dispatched_at TIMESTAMPTZ,
    last_reconciled_at TIMESTAMPTZ,
    reconcile_lease_id TEXT,
    reconcile_lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
}

export function continuationOutboxIndexSql(table: string): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS ${table}_due_idx ON ${table} (next_attempt_at, created_at) WHERE status IN ('pending', 'dispatching')`,
    `CREATE INDEX IF NOT EXISTS ${table}_reconcile_idx ON ${table} (COALESCE(last_reconciled_at, dispatched_at, updated_at), run_id) WHERE status='dispatched'`,
  ];
}

export async function enqueueContinuation(
  host: TaskboardContinuationOutboxHost,
  taskId: string,
  commentIds: string[],
  runId: string,
  commentId: string,
  payload: TaskboardContinuationDispatchPayload,
): Promise<boolean> {
  if (commentIds.length === 0) return false;
  try {
    return await withTransaction(host.pool, async (client) => {
      const claimed = await client.query(
        `UPDATE ${host.commentsTable}
            SET continuation_run_id=$3, updated_at=now()
          WHERE task_id=$1 AND id=ANY($2::text[]) AND continuation_eligible=true
            AND (continuation_run_id IS NULL OR continuation_run_id=$3)
          RETURNING id`,
        [taskId, commentIds, runId],
      );
      if (claimed.rowCount !== commentIds.length) throw new PartialContinuationClaimError();
      await client.query(
        `INSERT INTO ${host.continuationOutboxTable}
           (run_id, task_id, comment_id, session_id, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (run_id) DO NOTHING`,
        [runId, taskId, commentId, payload.session.sessionId, JSON.stringify(payload)],
      );
      return true;
    });
  } catch (error) {
    if (error instanceof PartialContinuationClaimError) return false;
    throw error;
  }
}

export async function claimContinuationDispatch(
  host: TaskboardContinuationOutboxHost,
  runId: string | undefined,
  leaseId: string,
): Promise<TaskboardContinuationDispatch | null> {
  const result = await host.pool.query(
    `WITH candidate AS (
       SELECT o.run_id
         FROM ${host.continuationOutboxTable} o
        WHERE ($2::text IS NULL OR o.run_id=$2)
          AND (
            (o.status='pending' AND o.next_attempt_at <= now())
            OR (o.status='dispatching' AND o.lease_expires_at <= now())
          )
        ORDER BY o.next_attempt_at, o.created_at, o.run_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     ), claimed AS (
       UPDATE ${host.continuationOutboxTable} o
          SET status='dispatching', attempt_count=o.attempt_count+1,
              lease_id=$1, lease_expires_at=now() + interval '60 seconds', updated_at=now()
         FROM candidate c
        WHERE o.run_id=c.run_id
        RETURNING o.*
     )
     SELECT c.*, b.tenant_id, b.owner_user_id
       FROM claimed c
       JOIN ${host.tasksTable} t ON t.id=c.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id`,
    [leaseId, runId ?? null],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    runId: String(row.run_id),
    taskId: String(row.task_id),
    commentId: String(row.comment_id),
    sessionId: String(row.session_id),
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    payload: row.payload as TaskboardContinuationDispatchPayload,
    attemptCount: Number(row.attempt_count),
    leaseId: String(row.lease_id),
  };
}

export async function markContinuationDispatchSucceeded(
  host: TaskboardContinuationOutboxHost,
  runId: string,
  leaseId: string,
): Promise<boolean> {
  const result = await host.pool.query(
    `UPDATE ${host.continuationOutboxTable}
        SET status='dispatched', dispatched_at=COALESCE(dispatched_at, now()),
            lease_id=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=now()
      WHERE run_id=$1 AND status='dispatching' AND lease_id=$2
      RETURNING run_id`,
    [runId, leaseId],
  );
  return Boolean(result.rows[0]);
}

export async function retryContinuationDispatch(
  host: TaskboardContinuationOutboxHost,
  runId: string,
  leaseId: string,
  error: string,
  delayMs: number,
): Promise<boolean> {
  const result = await host.pool.query(
    `UPDATE ${host.continuationOutboxTable}
        SET status='pending', lease_id=NULL, lease_expires_at=NULL,
            next_attempt_at=now() + ($4::double precision * interval '1 millisecond'),
            last_error=$3, updated_at=now()
      WHERE run_id=$1 AND status='dispatching' AND lease_id=$2
      RETURNING run_id`,
    [runId, leaseId, requireText(error, 'Dispatch error'), Math.max(0, Math.floor(delayMs))],
  );
  return Boolean(result.rows[0]);
}

export async function claimContinuationReconcileCandidates(
  host: TaskboardContinuationOutboxHost,
  staleBefore: Date,
  limit: number,
  leaseId: string,
): Promise<TaskboardContinuationReconcileCandidate[]> {
  const result = await host.pool.query(
    `WITH candidates AS (
       SELECT o.run_id
         FROM ${host.continuationOutboxTable} o
        WHERE o.status='dispatched'
          AND COALESCE(o.last_reconciled_at, o.dispatched_at, o.updated_at) <= $1
          AND (o.reconcile_lease_expires_at IS NULL OR o.reconcile_lease_expires_at <= now())
        ORDER BY COALESCE(o.last_reconciled_at, '-infinity'::timestamptz), o.updated_at, o.run_id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
     ), claimed AS (
       UPDATE ${host.continuationOutboxTable} o
          SET last_reconciled_at=now(), reconcile_lease_id=$3,
              reconcile_lease_expires_at=now() + interval '30 seconds'
         FROM candidates c
        WHERE o.run_id=c.run_id
        RETURNING o.run_id, o.task_id, o.session_id, o.reconcile_lease_id
     ) SELECT * FROM claimed`,
    [staleBefore, Math.max(1, Math.min(500, Math.floor(limit))), leaseId],
  );
  return result.rows.map((row) => ({
    runId: String(row.run_id),
    taskId: String(row.task_id),
    sessionId: String(row.session_id),
    leaseId: String(row.reconcile_lease_id),
  }));
}

export async function releaseContinuationReconcile(
  host: TaskboardContinuationOutboxHost,
  runId: string,
  leaseId: string,
): Promise<boolean> {
  const result = await host.pool.query(
    `UPDATE ${host.continuationOutboxTable}
        SET reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL
      WHERE run_id=$1 AND status='dispatched' AND reconcile_lease_id=$2
      RETURNING run_id`,
    [runId, leaseId],
  );
  return Boolean(result.rows[0]);
}

export async function finishContinuation(
  host: TaskboardContinuationOutboxHost,
  runId: string,
  leaseId?: string,
): Promise<boolean> {
  const params: unknown[] = [runId];
  const leaseCondition = leaseId ? 'AND reconcile_lease_id=$2' : '';
  if (leaseId) params.push(leaseId);
  const result = await host.pool.query(
    `UPDATE ${host.continuationOutboxTable}
        SET status='completed', reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL,
            lease_id=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE run_id=$1 AND status<>'completed' ${leaseCondition}
      RETURNING run_id`,
    params,
  );
  return Boolean(result.rows[0]);
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
