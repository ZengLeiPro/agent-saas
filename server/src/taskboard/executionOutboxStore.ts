import type { Pool, PoolClient } from 'pg';

import {
  isTerminalExecutionStatus,
  requireText,
  rowToExecutionDispatch,
  rowToExecutionReconcileCandidate,
} from './storeHelpers.js';
import type {
  TaskboardExecutionDispatch,
  TaskboardExecutionReconcileCandidate,
} from './types.js';

export interface TaskboardExecutionOutboxHost {
  pool: Pool;
  boardsTable: string;
  tasksTable: string;
  executionsTable: string;
  executionOutboxTable: string;
  cancellationOutboxTable: string;
}

export async function runExecutionOutboxMigrations(
  host: TaskboardExecutionOutboxHost,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE ${host.executionsTable} e
        SET status='cancelled', error=COALESCE(e.error, 'Task archived before execution completed'),
            finished_at=COALESCE(e.finished_at, now()), updated_at=now(),
            reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL
       FROM ${host.tasksTable} t JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE e.task_id=t.id AND e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
        AND (t.archived_at IS NOT NULL OR b.archived_at IS NOT NULL)`,
  );
  await client.query(
    `UPDATE ${host.executionOutboxTable} o
        SET status='dispatched', lease_id=NULL, lease_expires_at=NULL, updated_at=now()
       FROM ${host.executionsTable} e
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE o.run_id=e.run_id AND (t.archived_at IS NOT NULL OR b.archived_at IS NOT NULL)
        AND (o.status<>'dispatched' OR o.lease_id IS NOT NULL OR o.lease_expires_at IS NOT NULL)`,
  );
}

/** Claims the outbox payload together with authoritative execution/task workload fields. */
export async function claimExecutionDispatch(
  host: TaskboardExecutionOutboxHost,
  runId: string | undefined,
  leaseId: string,
): Promise<TaskboardExecutionDispatch | null> {
  const result = await host.pool.query(
    `WITH legacy_outbox AS (
       UPDATE ${host.executionOutboxTable} o
          SET status='dispatched', lease_id=NULL, lease_expires_at=NULL,
              last_error='Integration task requires Agent-first workflow migration',
              dispatched_at=COALESCE(o.dispatched_at, now()), updated_at=now()
         FROM ${host.executionsTable} e
         JOIN ${host.tasksTable} t ON t.id=e.task_id
        WHERE o.run_id=e.run_id AND ($2::text IS NULL OR o.run_id=$2)
          AND t.kind='integration' AND t.workflow_version<>3
          AND (o.status='pending'
            OR (o.status='dispatching' AND o.lease_expires_at <= now()))
        RETURNING o.run_id
     ), legacy_execution AS (
       UPDATE ${host.executionsTable} e
          SET status='failed', error='Integration task requires Agent-first workflow migration',
              finished_at=COALESCE(e.finished_at, now()), updated_at=now(),
              reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL
        WHERE e.run_id IN (SELECT run_id FROM legacy_outbox)
          AND e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
        RETURNING e.run_id
     ), candidate AS (
       SELECT o.run_id FROM ${host.executionOutboxTable} o
       JOIN ${host.executionsTable} e ON e.run_id=o.run_id
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
       WHERE ($2::text IS NULL OR o.run_id=$2)
         AND NOT (t.kind='integration' AND t.workflow_version<>3)
         AND t.archived_at IS NULL AND b.archived_at IS NULL
         AND e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
         AND NOT EXISTS (
           SELECT 1 FROM ${host.cancellationOutboxTable} cancellation
           WHERE cancellation.execution_id=e.id
             AND cancellation.status IN ('pending','processing','failed')
         )
         AND ((o.status='pending' AND o.next_attempt_at <= now())
           OR (o.status='dispatching' AND o.lease_expires_at <= now()))
       ORDER BY o.next_attempt_at, o.created_at, o.run_id
       FOR UPDATE OF o SKIP LOCKED LIMIT 1
     ), claimed AS (
       UPDATE ${host.executionOutboxTable} o
       SET status='dispatching', attempt_count=o.attempt_count+1, lease_id=$1,
           lease_expires_at=now() + interval '60 seconds', updated_at=now()
       FROM candidate c WHERE o.run_id=c.run_id RETURNING o.*
     )
     SELECT c.*, e.id AS actual_execution_id, e.task_id AS actual_task_id,
            e.session_id AS actual_session_id, t.kind AS actual_task_kind,
            e.purpose AS actual_purpose, b.tenant_id, b.owner_user_id
     FROM claimed c JOIN ${host.executionsTable} e ON e.run_id=c.run_id
     JOIN ${host.tasksTable} t ON t.id=e.task_id JOIN ${host.boardsTable} b ON b.id=t.board_id`,
    [leaseId, runId ?? null],
  );
  return result.rows[0] ? rowToExecutionDispatch(result.rows[0]) : null;
}

export async function runExecutionDispatchGate(
  host: TaskboardExecutionOutboxHost,
  runId: string,
  leaseId: string,
  operation: () => Promise<void>,
): Promise<boolean> {
  return withTransaction(host.pool, async (client) => {
    const admitted = await client.query(
      `SELECT e.id
       FROM ${host.executionsTable} e
       JOIN ${host.executionOutboxTable} o ON o.run_id=e.run_id
       WHERE e.run_id=$1
         AND e.status IN ('queued','running','waiting_user','waiting_approval')
         AND o.status='dispatching' AND o.lease_id=$2
         AND NOT EXISTS (
           SELECT 1 FROM ${host.cancellationOutboxTable} cancellation
           WHERE cancellation.execution_id=e.id
             AND cancellation.status IN ('pending','processing','failed')
         )
       FOR UPDATE OF e,o`,
      [runId, leaseId],
    );
    if (!admitted.rows[0]) {
      await client.query(
        `UPDATE ${host.executionOutboxTable} o
         SET status='dispatched',lease_id=NULL,lease_expires_at=NULL,updated_at=now()
         FROM ${host.executionsTable} e
         WHERE o.run_id=$1 AND o.run_id=e.run_id
           AND o.status='dispatching' AND o.lease_id=$2
           AND (
             e.status IN ('succeeded','failed','cancelled')
             OR EXISTS (
               SELECT 1 FROM ${host.cancellationOutboxTable} cancellation
               WHERE cancellation.execution_id=e.id
                 AND cancellation.status IN ('pending','processing','failed')
             )
           )`,
        [runId, leaseId],
      );
      return false;
    }
    // The execution row lock is deliberately held across durable Runtime Run creation.
    // A concurrent workflow fence must wait; once it proceeds, the run exists and the
    // canonical cancellation transaction can cancel target/steering/tools atomically.
    await operation();
    return true;
  });
}

export function markExecutionDispatchSucceeded(
  host: TaskboardExecutionOutboxHost,
  runId: string,
  leaseId: string,
): Promise<boolean> {
  return withTransaction(host.pool, async (client) => {
    const executionResult = await client.query(
      `SELECT status FROM ${host.executionsTable} WHERE run_id=$1 FOR UPDATE`, [runId],
    );
    if (!executionResult.rows[0]) return false;
    const dispatched = await client.query(
      `UPDATE ${host.executionOutboxTable}
       SET status='dispatched', lease_id=NULL, lease_expires_at=NULL,
           last_error=NULL, dispatched_at=now(), updated_at=now()
       WHERE run_id=$1 AND status='dispatching' AND lease_id=$2 RETURNING execution_id`,
      [runId, leaseId],
    );
    if (!dispatched.rows[0]) return false;
    if (!isTerminalExecutionStatus(String(executionResult.rows[0].status))) {
      await client.query(`UPDATE ${host.executionsTable} SET error=NULL, updated_at=now() WHERE run_id=$1`, [runId]);
    }
    return true;
  });
}

export function retryExecutionDispatch(
  host: TaskboardExecutionOutboxHost,
  runId: string,
  leaseId: string,
  error: string,
  delayMs: number,
): Promise<boolean> {
  return withTransaction(host.pool, async (client) => {
    const executionResult = await client.query(
      `SELECT status FROM ${host.executionsTable} WHERE run_id=$1 FOR UPDATE`, [runId],
    );
    if (!executionResult.rows[0]) return false;
    if (isTerminalExecutionStatus(String(executionResult.rows[0].status))) {
      await client.query(
        `UPDATE ${host.executionOutboxTable} SET status='dispatched', lease_id=NULL,
         lease_expires_at=NULL, updated_at=now()
         WHERE run_id=$1 AND status='dispatching' AND lease_id=$2`,
        [runId, leaseId],
      );
      return false;
    }
    const message = requireText(error, 'Dispatch error');
    const retried = await client.query(
      `UPDATE ${host.executionOutboxTable} SET status='pending', lease_id=NULL, lease_expires_at=NULL,
       next_attempt_at=now() + ($4::double precision * interval '1 millisecond'),
       last_error=$3, updated_at=now()
       WHERE run_id=$1 AND status='dispatching' AND lease_id=$2 RETURNING execution_id`,
      [runId, leaseId, message, Math.max(0, Math.floor(delayMs))],
    );
    if (!retried.rows[0]) return false;
    await client.query(`UPDATE ${host.executionsTable} SET error=$2, updated_at=now() WHERE run_id=$1`, [runId, message]);
    return true;
  });
}

export async function claimExecutionReconcileCandidates(
  host: TaskboardExecutionOutboxHost,
  staleBefore: Date,
  limit: number,
  leaseId: string,
): Promise<TaskboardExecutionReconcileCandidate[]> {
  const result = await host.pool.query(
    `WITH legacy_candidates AS (
       SELECT e.run_id FROM ${host.executionsTable} e
       JOIN ${host.executionOutboxTable} o ON o.run_id=e.run_id
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
       WHERE e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
         AND o.status='dispatched' AND t.kind='integration' AND t.workflow_version<>3
         AND t.archived_at IS NULL AND b.archived_at IS NULL
         AND e.updated_at <= $1
         AND (e.reconcile_lease_expires_at IS NULL OR e.reconcile_lease_expires_at <= clock_timestamp())
       ORDER BY COALESCE(e.last_reconciled_at, '-infinity'::timestamptz), e.updated_at, e.run_id
       FOR UPDATE OF e, o SKIP LOCKED LIMIT $2
     ), legacy_execution AS (
       UPDATE ${host.executionsTable} e
          SET status='failed', error='Integration task requires Agent-first workflow migration',
              finished_at=COALESCE(e.finished_at, now()), updated_at=now(),
              reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL
         FROM legacy_candidates legacy WHERE e.run_id=legacy.run_id
       RETURNING e.run_id
     ), legacy_outbox AS (
       UPDATE ${host.executionOutboxTable} o
          SET status='dispatched', lease_id=NULL, lease_expires_at=NULL,
              last_error='Integration task requires Agent-first workflow migration',
              dispatched_at=COALESCE(o.dispatched_at, now()), updated_at=now()
         FROM legacy_execution legacy WHERE o.run_id=legacy.run_id
       RETURNING o.run_id
     ), candidates AS (
       SELECT e.run_id FROM ${host.executionsTable} e
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
       WHERE e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
         AND NOT (t.kind='integration' AND t.workflow_version<>3)
         AND t.archived_at IS NULL AND b.archived_at IS NULL
         AND e.updated_at <= $1
         AND (e.reconcile_lease_expires_at IS NULL OR e.reconcile_lease_expires_at <= clock_timestamp())
       ORDER BY COALESCE(e.last_reconciled_at, '-infinity'::timestamptz), e.updated_at, e.run_id
       FOR UPDATE OF e SKIP LOCKED LIMIT $2
     ), claimed AS (
       UPDATE ${host.executionsTable} e SET last_reconciled_at=now(), reconcile_lease_id=$3,
         reconcile_lease_expires_at=now() + interval '30 seconds'
       FROM candidates c WHERE e.run_id=c.run_id
       RETURNING e.run_id, e.id AS execution_id, e.session_id, e.status, e.reconcile_lease_id
     )
     SELECT c.run_id, c.execution_id, c.session_id, c.status, c.reconcile_lease_id,
            o.status AS dispatch_status FROM claimed c
     LEFT JOIN ${host.executionOutboxTable} o ON o.run_id=c.run_id`,
    [staleBefore, Math.max(1, Math.min(500, Math.floor(limit))), leaseId],
  );
  return result.rows.map(rowToExecutionReconcileCandidate);
}

async function withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
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
