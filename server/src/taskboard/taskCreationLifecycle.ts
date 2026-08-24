import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { rowToTask, visibleCommentPredicate } from './storeHelpers.js';
import { TaskboardValidationError, type TaskboardTaskCreateResult } from './types.js';

const CREATION_POLL_MS = 50;

export function taskCreationRequestDigest(input: Record<string, unknown>): string {
  const { clientRequestId: _clientRequestId, ...payload } = input;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function newTaskCreationClaim(clientRequestId: string | undefined): {
  state: 'pending' | 'complete'; token: string | null;
} {
  if (!clientRequestId) return { state: 'complete', token: null };
  return { state: 'pending', token: randomUUID() };
}

export async function claimExistingTaskCreation(
  client: PoolClient,
  tables: { tasksTable: string; commentsTable: string; changesTable: string },
  boardId: string,
  clientRequestId: string,
  creationRequestDigest: string,
): Promise<TaskboardTaskCreateResult | null> {
  const existing = await client.query(
    `SELECT t.*, (t.creation_lease_expires_at > now()) AS creation_lease_active,
            (SELECT count(*)::int FROM ${tables.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', tables.changesTable)}) AS comment_count
       FROM ${tables.tasksTable} t
      WHERE t.board_id=$1 AND t.client_request_id=$2 AND t.deleted_at IS NULL
      FOR UPDATE OF t`,
    [boardId, clientRequestId],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.creation_request_digest !== null && row.creation_request_digest !== creationRequestDigest) {
    throw new TaskboardValidationError(
      'Task creation idempotency key was already used with a different request',
      'TASKBOARD_CREATE_IDEMPOTENCY_CONFLICT',
    );
  }
  if (row.creation_request_digest === null && row.creation_state === 'pending') {
    throw new TaskboardValidationError(
      'Pending legacy task creation cannot be safely resumed',
      'TASKBOARD_CREATE_IDEMPOTENCY_CONFLICT',
    );
  }
  if (row.creation_state === 'complete') return { task: rowToTask(row), created: false };
  if (row.creation_lease_active === true) return { task: rowToTask(row), created: false, creationPending: true };
  const creationClaimToken = randomUUID();
  const claimed = await client.query(
    `UPDATE ${tables.tasksTable}
        SET creation_lease_id=$2,creation_lease_expires_at=now()+interval '5 minutes',updated_at=now()
      WHERE id=$1 AND creation_state='pending'
      RETURNING *`,
    [row.id, creationClaimToken],
  );
  return {
    task: rowToTask({ ...claimed.rows[0], comment_count: row.comment_count }),
    created: false,
    creationClaimToken,
  };
}

export async function waitForTaskCreationClaim(
  initial: TaskboardTaskCreateResult,
  retry: () => Promise<TaskboardTaskCreateResult>,
): Promise<TaskboardTaskCreateResult> {
  let result = initial;
  while (result.creationPending) {
    await new Promise((resolve) => setTimeout(resolve, CREATION_POLL_MS));
    result = await retry();
  }
  return result;
}

export async function releaseTaskCreationAfterFailure(
  error: unknown,
  cleanup: () => Promise<void>,
  release: () => Promise<void>,
): Promise<never> {
  let cleanupError: unknown;
  try { await cleanup(); } catch (caught) { cleanupError = caught; }
  try { await release(); } catch (caught) { cleanupError ??= caught; }
  if (cleanupError) {
    throw new Error(
      `Task creation failed and claim cleanup failed: ${String(error)}; ${String(cleanupError)}`,
      { cause: error },
    );
  }
  throw error;
}

export async function completeTaskCreationClaim(
  client: PoolClient,
  tasksTable: string,
  taskId: string,
  claimToken: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE ${tasksTable}
        SET creation_state='complete',creation_lease_id=NULL,creation_lease_expires_at=NULL,updated_at=now()
      WHERE id=$1 AND creation_state='pending' AND creation_lease_id=$2`,
    [taskId, claimToken],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function releaseTaskCreationClaim(
  client: PoolClient,
  tasksTable: string,
  taskId: string,
  claimToken: string,
): Promise<void> {
  await client.query(
    `UPDATE ${tasksTable}
        SET creation_lease_id=NULL,creation_lease_expires_at=NULL,updated_at=now()
      WHERE id=$1 AND creation_state='pending' AND creation_lease_id=$2`,
    [taskId, claimToken],
  );
}
