import { randomUUID } from 'node:crypto';

import type {
  TaskBoardExecution,
  TaskBoardExecutionStartResult,
} from '../../../shared/src/types/taskboard.js';
import { finalizeExecutionForArchivedTask } from './archiveGuard.js';
import { nextTaskColumnSortOrder } from './continuationStore.js';
import { applyExecutionTaskCompletion, enqueueAutomaticReview } from './executionCompletion.js';
import { resolveExecutionModelRef, resolveExecutionPurpose } from './executionFields.js';
import {
  assertExecutionConfiguration,
  assertExpectedVersion,
  assertWritableTask,
  isTerminalExecutionStatus,
  isUniqueViolation,
  normalizeAttachments,
  optionalText,
  requireText,
  rowToExecution,
} from './storeHelpers.js';
import type { PgTaskboardStore } from './store.js';
import {
  TaskboardPermissionError,
  TaskboardValidationError,
  type TaskboardExecutionClaimInput,
  type TaskboardExecutionCompletionInput,
  type TaskboardIdentity,
} from './types.js';
import { appendTaskChange } from './v2Store.js';

function assertBoardRole(role: 'viewer' | 'editor' | 'maintainer' | 'owner' | undefined): void {
  if (!role || role === 'viewer') {
    throw new TaskboardPermissionError('Taskboard role does not allow this operation');
  }
}

export async function claimExecution(
  store: PgTaskboardStore,
  identity: TaskboardIdentity,
  taskId: string,
  input: TaskboardExecutionClaimInput,
): Promise<TaskBoardExecutionStartResult> {
  return store.withTransaction(async (client) => {
    const loaded = await store.requireTaskWithBoard(client, identity, taskId, true);
    assertBoardRole(loaded.boardRole);
    assertWritableTask(loaded.task, loaded.boardArchivedAt);
    const purpose = input.allowWorkFromCurrentStatus
      ? 'work'
      : resolveExecutionPurpose(loaded.task.status, input.purpose, loaded.task.kind);
    assertExecutionConfiguration(
      resolveExecutionModelRef(
        loaded.task.model,
        loaded.boardStageModels,
        loaded.boardModel,
        purpose,
      ),
      input.configuredModelRef,
      loaded.boardOwnerUserId,
      input.executionOwnerUserId,
    );
    const duplicate = await client.query(
      `SELECT * FROM ${store.executionsTable} WHERE id=$1 OR run_id=$2 LIMIT 1`,
      [input.executionId, input.runId],
    );
    if (duplicate.rows[0]) {
      const execution = rowToExecution(duplicate.rows[0]);
      if (execution.taskId !== taskId || execution.purpose !== purpose) {
        throw new TaskboardValidationError('Execution idempotency key conflict');
      }
      return { task: loaded.task, execution };
    }
    if (
      loaded.task.kind !== 'integration'
      && (purpose === 'work' || purpose === 'review')
      && (!loaded.boardRepository || loaded.boardRepository.provider !== 'github')
    ) {
      throw new TaskboardValidationError(
        'Board repository is not configured; execution cannot register pull request evidence',
        'TASKBOARD_REPOSITORY_REQUIRED',
      );
    }
    const active = await client.query(
      `SELECT 1 WHERE EXISTS (
         SELECT 1 FROM ${store.executionsTable}
          WHERE task_id=$1 AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
       ) OR EXISTS (
         SELECT 1 FROM ${store.continuationOutboxTable}
          WHERE task_id=$1 AND status<>'completed'
       )`,
      [taskId],
    );
    if (active.rows[0]) {
      throw new TaskboardValidationError(
        'Task already has an active Agent execution',
        'TASKBOARD_EXECUTION_ACTIVE',
      );
    }
    assertExpectedVersion(loaded.task, input.expectedVersion);

    const runningTaskStatus = purpose === 'review' ? 'in_review' : 'in_progress';
    const sortOrder = purpose === 'review' || purpose === 'merge'
      ? loaded.task.sortOrder
      : await nextTaskColumnSortOrder(
        store,
        client,
        identity,
        loaded.task.boardId,
        taskId,
        runningTaskStatus,
      );

    const attemptId = input.attemptId ?? randomUUID();
    let execution: TaskBoardExecution;
    try {
      const inserted = await client.query(
        `INSERT INTO ${store.executionsTable}
           (id, task_id, run_id, session_id, status, purpose, trigger, protocol_version, attempt_id, requested_by)
         VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          input.executionId, taskId, input.runId, input.sessionId, purpose,
          input.trigger ?? 'initial', input.protocolVersion ?? 2, attemptId,
          identity.ownerUserId,
        ],
      );
      await client.query(
        `INSERT INTO ${store.executionOutboxTable}
           (run_id, execution_id, payload)
         VALUES ($1,$2,$3::jsonb)`,
        [input.runId, input.executionId, JSON.stringify(input.dispatch)],
      );
      await client.query(
        `INSERT INTO ${store.attemptsTable}
           (id, execution_id, run_id, trigger, dispatch_source, actor_user_id, policy_revision,
            context_start_seq, subject_digest, lane_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9,$10)`,
        [
          attemptId, input.executionId, input.runId, input.trigger ?? 'initial',
          input.trigger === 'comment' ? 'comment' : 'direct', identity.ownerUserId,
          input.policyRevision ?? null, input.contextStartSeq ?? '0', input.subjectDigest ?? null,
          input.laneEpoch ?? null,
        ],
      );
      execution = rowToExecution(inserted.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new TaskboardValidationError(
          'Task already has an active Agent execution',
          'TASKBOARD_EXECUTION_ACTIVE',
        );
      }
      throw error;
    }

    await client.query(
      `UPDATE ${store.commentsTable}
          SET continuation_run_id=$2, updated_at=now()
        WHERE task_id=$1 AND author_type='user' AND continuation_eligible=true
          AND continuation_run_id IS NULL`,
      [taskId, input.runId],
    );
    if (purpose === 'merge' && loaded.task.status === 'blocked') {
      await client.query(
        `UPDATE ${store.integrationSourcesTable}
            SET state='pending', last_error=NULL, updated_at=now()
          WHERE integration_task_id=$1 AND state='needs_human'`,
        [taskId],
      );
    }
    await client.query(
      `UPDATE ${store.tasksTable}
          SET status=$2, sort_order=$3, completed_at=NULL,
              version=version+1, updated_at=now()
        WHERE id=$1`,
      [taskId, runningTaskStatus, sortOrder],
    );
    await client.query(
      `UPDATE ${store.blockEpisodesTable} SET closed_at=now()
        WHERE task_id=$1 AND closed_at IS NULL`,
      [taskId],
    );
    await appendTaskChange(store, client, taskId, 'execution.claimed', 'user', identity.ownerUserId, {
      executionId: execution.id,
      runId: execution.runId,
      purpose,
      trigger: execution.trigger,
      from: loaded.task.status,
      to: runningTaskStatus,
    });
    return {
      task: await store.requireTask(client, identity, taskId, false),
      execution,
    };
  });
}

export async function setExecutionStatus(
  store: PgTaskboardStore,
  runId: string,
  status: 'running' | 'waiting_user' | 'waiting_approval',
): Promise<TaskBoardExecution | null> {
  const result = await store.pool.query(
    `UPDATE ${store.executionsTable}
        SET status=$2,
            started_at=COALESCE(started_at, now()),
            updated_at=now(),
            reconcile_lease_id=NULL,
            reconcile_lease_expires_at=NULL
      WHERE run_id=$1
        AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
      RETURNING *`,
    [runId, status],
  );
  return result.rows[0] ? rowToExecution(result.rows[0]) : null;
}

export async function setExecutionStatusFromReconcile(
  store: PgTaskboardStore,
  runId: string,
  status: 'running' | 'waiting_user' | 'waiting_approval',
  leaseId: string,
): Promise<TaskBoardExecution | null> {
  const result = await store.pool.query(
    `UPDATE ${store.executionsTable}
        SET status=$2,
            started_at=COALESCE(started_at, now()),
            updated_at=now()
      WHERE run_id=$1
        AND reconcile_lease_id=$3
        AND reconcile_lease_expires_at > clock_timestamp()
        AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
      RETURNING *`,
    [runId, status, leaseId],
  );
  return result.rows[0] ? rowToExecution(result.rows[0]) : null;
}

export async function completeExecution(
  store: PgTaskboardStore,
  runId: string,
  input: TaskboardExecutionCompletionInput,
): Promise<TaskBoardExecutionStartResult | null> {
  return completeExecutionInternal(store, runId, input);
}

export async function completeExecutionFromReconcile(
  store: PgTaskboardStore,
  runId: string,
  input: TaskboardExecutionCompletionInput,
  leaseId: string,
): Promise<TaskBoardExecutionStartResult | null> {
  return completeExecutionInternal(store, runId, input, leaseId);
}

async function completeExecutionInternal(
  store: PgTaskboardStore,
  runId: string,
  input: TaskboardExecutionCompletionInput,
  reconcileLeaseId?: string,
): Promise<TaskBoardExecutionStartResult | null> {
  const ownership = await store.pool.query(
    `SELECT e.task_id, b.tenant_id, b.owner_user_id
       FROM ${store.executionsTable} e
       JOIN ${store.tasksTable} t ON t.id=e.task_id
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE e.run_id=$1`,
    [runId],
  );
  if (!ownership.rows[0]) return null;
  const identity: TaskboardIdentity = {
    tenantId: String(ownership.rows[0].tenant_id),
    ownerUserId: String(ownership.rows[0].owner_user_id),
    username: '',
  };
  const taskId = String(ownership.rows[0].task_id);

  return store.withTransaction(async (client) => {
    const loaded = await store.requireTaskWithBoard(client, identity, taskId, true);
    const executionResult = await client.query(
      `SELECT *,
              ($2::text IS NULL OR (
                reconcile_lease_id=$2 AND reconcile_lease_expires_at > clock_timestamp()
              )) AS reconcile_lease_valid
         FROM ${store.executionsTable}
        WHERE run_id=$1
        FOR UPDATE`,
      [runId, reconcileLeaseId ?? null],
    );
    if (!executionResult.rows[0] || executionResult.rows[0].reconcile_lease_valid !== true) return null;
    const currentExecution = rowToExecution(executionResult.rows[0]);
    if (isTerminalExecutionStatus(currentExecution.status)) {
      await client.query(
        `UPDATE ${store.executionOutboxTable}
            SET status='dispatched', lease_id=NULL, lease_expires_at=NULL, updated_at=now()
          WHERE run_id=$1 AND status<>'dispatched'`,
        [runId],
      );
      return { task: loaded.task, execution: currentExecution };
    }
    let completionInput = input;
    let hasProtocolResolution = false;
    if (currentExecution.protocolVersion === 2) {
      const resolution = await client.query(
        `SELECT 1 FROM ${store.changesTable}
          WHERE task_id=$1 AND change_type='execution.resolved' AND payload->>'runId'=$2
          LIMIT 1`,
        [taskId, runId],
      );
      hasProtocolResolution = Boolean(resolution.rows[0]);
      if (input.status === 'succeeded' && !hasProtocolResolution) {
        completionInput = {
          status: 'failed',
          error: 'TASKBOARD_PROTOCOL_INCOMPLETE',
          commentBody: 'Agent Run 已结束，但没有提交结构化任务结果。任务状态保持不变。',
        };
      }
    }
    const archivedResult = await finalizeExecutionForArchivedTask(
      store, client, loaded.task, loaded.boardArchivedAt, currentExecution, completionInput,
    );
    if (archivedResult) return archivedResult;

    const executionSucceeded = await applyExecutionTaskCompletion(
      store, client, identity, loaded.task, currentExecution, executionResult.rows[0].created_at, completionInput,
    );
    if (currentExecution.protocolVersion === 2 && !hasProtocolResolution && completionInput.status === 'failed') {
      const retryPolicy = await client.query(
        `SELECT count(*)::int AS failed_count,
                COALESCE((b.integration_policy->'execution'->>'maxTransientRetries')::int,3) AS max_retries
           FROM ${store.executionsTable} prior
           JOIN ${store.tasksTable} retry_task ON retry_task.id=$1
           JOIN ${store.boardsTable} b ON b.id=retry_task.board_id
          WHERE prior.task_id=$1 AND prior.purpose=$2 AND prior.protocol_version=2 AND prior.status='failed'
          GROUP BY b.integration_policy`,
        [taskId, currentExecution.purpose],
      );
      const failedCount = Number(retryPolicy.rows[0]?.failed_count ?? 0);
      const maxRetries = Math.max(0, Number(retryPolicy.rows[0]?.max_retries ?? 3));
      const exhausted = failedCount >= maxRetries;
      const retryStatus = exhausted
        ? 'blocked'
        : currentExecution.purpose === 'work'
          ? 'todo'
          : currentExecution.purpose === 'review'
            ? 'in_review'
            : 'in_progress';
      await client.query(
        `UPDATE ${store.tasksTable}
            SET status=$2, completed_at=NULL, version=version+1, updated_at=now()
          WHERE id=$1`,
        [taskId, retryStatus],
      );
      if (exhausted) {
        await client.query(
          `INSERT INTO ${store.blockEpisodesTable}
             (id, task_id, purpose, execution_id, reason_code, reason)
           VALUES ($1,$2,$3,$4,'automatic_retry_exhausted',$5)`,
          [randomUUID(), taskId, currentExecution.purpose, currentExecution.id,
            completionInput.error || 'Automatic execution retries exhausted'],
        );
      }
    }

    const updated = await client.query(
      `UPDATE ${store.executionsTable}
          SET status=$2, error=$3, finished_at=now(), updated_at=now(),
              reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL
        WHERE run_id=$1
        RETURNING *`,
      [runId, completionInput.status, optionalText(completionInput.error)],
    );
    await client.query(
      `UPDATE ${store.executionOutboxTable}
          SET status='dispatched', lease_id=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE run_id=$1 AND status<>'dispatched'`,
      [runId],
    );
    await enqueueAutomaticReview(
      store, client, loaded.task, currentExecution, executionSucceeded, completionInput.reviewExecution,
    );
    const authorType = completionInput.status === 'succeeded' ? 'agent' : 'system';
    await client.query(
      `INSERT INTO ${store.commentsTable}
         (id, task_id, body, attachments, author_type, author_id, author_name, version)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,1)`,
      [randomUUID(), taskId, requireText(completionInput.commentBody, 'Execution comment body'),
        JSON.stringify(normalizeAttachments(completionInput.attachments)), authorType, runId,
        completionInput.status === 'succeeded' ? 'Agent' : '系统'],
    );
    await appendTaskChange(store, client, taskId, 'execution.completed', 'system', runId, {
      executionId: currentExecution.id,
      purpose: currentExecution.purpose,
      status: completionInput.status,
      error: completionInput.error,
    });
    return {
      task: await store.requireTask(client, identity, taskId, false),
      execution: rowToExecution(updated.rows[0]),
    };
  });
}
