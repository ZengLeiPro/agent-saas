import { randomUUID } from 'node:crypto';

import type {
  TaskBoardExecution,
  TaskBoardExecutionPurpose,
  TaskBoardExecutionStartResult,
  TaskBoardStatus,
} from '../../../shared/src/types/taskboard.js';
import { finalizeExecutionForArchivedTask } from './archiveGuard.js';
import { nextTaskColumnSortOrder } from './continuationStore.js';
import {
  applyExecutionTaskCompletion,
  enqueueAutomaticReview,
} from './executionCompletion.js';
import { resolveExecutionModelRef } from './executionFields.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import {
  assertExecutionRequestAllowed,
  assertIntegrationExecutionMigrated,
  isIrreversibleMerged,
  purposeForIntegrationAgentStatus,
  type WorkflowFacts,
} from './workflow/decider.js';
import { loadWorkflowFacts } from './workflow/commandService.js';
import {
  assertExecutionConfiguration,
  assertExpectedVersion,
  assertWritableTask,
  isTerminalExecutionStatus,
  isUniqueViolation,
  optionalText,
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

export function shouldPersistIntegrationDurableSession(
  integrationAgent: boolean,
  purpose: TaskBoardExecutionPurpose,
): boolean {
  return integrationAgent && purpose === 'work';
}

function assertBoardRole(role: 'viewer' | 'editor' | 'maintainer' | 'owner' | undefined): void {
  if (!role || role === 'viewer') {
    throw new TaskboardPermissionError('Taskboard role does not allow this operation');
  }
}

export function unresolvedExecutionRecovery(
  purpose: TaskBoardExecutionPurpose,
  completionStatus: 'failed' | 'cancelled',
  failedCount: number,
  maxRetries: number,
  options: { agentFirstIntegration?: boolean } = {},
): { status: TaskBoardStatus; exhausted: boolean } {
  if (options.agentFirstIntegration) {
    // Runtime/network completion failures are not business decisions. Keep the
    // durable Agent stage dispatchable; the scheduler creates a fresh Execution
    // through the normal outbox instead of retrying synchronously.
    return {
      exhausted: false,
      status: purpose === 'review'
        ? 'in_review'
        : purpose === 'merge'
          ? 'ready_to_merge'
          : 'in_progress',
    };
  }
  const exhausted = completionStatus === 'failed' && failedCount >= Math.max(0, maxRetries);
  return {
    exhausted,
    status: exhausted
      ? 'blocked'
      : purpose === 'work'
        ? 'todo'
        : purpose === 'review'
          ? 'in_review'
          : 'in_progress',
  };
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
    assertIntegrationExecutionMigrated(loaded.task);
    const purpose = input.purpose
      ?? (loaded.task.kind === 'integration'
        ? purposeForIntegrationAgentStatus(loaded.task.status)
        : undefined)
      ?? 'work';
    // Authorization and object visibility are checked above. Idempotent replay must be resolved
    // before mutable task/workflow checks, otherwise a successful request cannot be retried after
    // the task has advanced to blocked/done/merged.
    const duplicate = await client.query(
      `SELECT *, id=$1 AS id_match, run_id=$2 AS run_match
         FROM ${store.executionsTable} WHERE id=$1 OR run_id=$2
        ORDER BY CASE WHEN id=$1 THEN 0 ELSE 1 END`,
      [input.executionId, input.runId],
    );
    if (duplicate.rows.length > 1) {
      throw new TaskboardValidationError(
        'Execution idempotency keys refer to different executions',
        'TASKBOARD_EXECUTION_IDEMPOTENCY_CONFLICT',
      );
    }
    if (duplicate.rows[0]) {
      const execution = rowToExecution(duplicate.rows[0]);
      if (execution.taskId !== taskId || execution.purpose !== purpose
        || execution.requestedBy !== identity.ownerUserId) {
        throw new TaskboardValidationError(
          'Execution idempotency key conflict',
          'TASKBOARD_EXECUTION_IDEMPOTENCY_CONFLICT',
        );
      }
      return { task: loaded.task, execution };
    }
    const facts: WorkflowFacts = await loadWorkflowFacts(store, client, loaded.task);
    let integrationAgent = false;
    if (loaded.task.kind === 'integration' && loaded.task.workflowVersion === 3) {
      const { agentsTable } = integrationAgentTableNames(store.integrationSourcesTable);
      const agent = await client.query(
        `SELECT integration_task_id FROM ${agentsTable} WHERE integration_task_id=$1 FOR UPDATE`, [taskId],
      );
      integrationAgent = Boolean(agent.rows[0]);
    }
    if (loaded.task.status === 'done' || loaded.task.status === 'canceled'
      || isIrreversibleMerged(loaded.task, facts)) {
      assertExecutionRequestAllowed(loaded.task, purpose, { facts });
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
    assertExecutionRequestAllowed(loaded.task, purpose, {
      allowInitialInProgress: input.trigger === 'initial',
      facts,
    });
    assertExecutionConfiguration(
      resolveExecutionModelRef(
        loaded.task.model,
        loaded.boardStageModels,
        loaded.boardModel,
        purpose,
        loaded.task.stageModels,
      ),
      input.configuredModelRef,
      loaded.boardOwnerUserId,
      input.executionOwnerUserId,
    );
    if (
      loaded.task.kind !== 'integration'
      && loaded.task.kind !== 'advisory'
      && (purpose === 'work' || purpose === 'review')
      && (!loaded.boardRepository || loaded.boardRepository.provider !== 'github')
    ) {
      throw new TaskboardValidationError(
        'Board repository is not configured; execution cannot register pull request evidence',
        'TASKBOARD_REPOSITORY_REQUIRED',
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

    if (shouldPersistIntegrationDurableSession(integrationAgent, purpose)) {
      const { agentsTable } = integrationAgentTableNames(store.integrationSourcesTable);
      await client.query(
        `UPDATE ${agentsTable} SET durable_session_id=COALESCE(durable_session_id,$2),updated_at=now()
          WHERE integration_task_id=$1`,
        [taskId, input.sessionId],
      );
    }
    await client.query(
      `UPDATE ${store.commentsTable}
          SET continuation_run_id=$2, updated_at=now()
        WHERE task_id=$1 AND author_type='user' AND continuation_eligible=true
          AND continuation_run_id IS NULL`,
      [taskId, input.runId],
    );
    await client.query(
      `UPDATE ${store.tasksTable}
          SET status=$2, sort_order=$3, completed_at=NULL,
              resume_context=CASE
                WHEN resume_context IS NOT NULL
                  AND resume_context->>'consumedAt' IS NULL
                  AND resume_context->>'purpose'=$4::text
                THEN resume_context || jsonb_build_object(
                  'consumedAt',clock_timestamp(),'consumedExecutionId',$5::text
                )
                ELSE resume_context
              END,
              version=version+1, updated_at=now()
        WHERE id=$1`,
      [taskId, runningTaskStatus, sortOrder, purpose, execution.id],
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
    const completionInput = input;
    const hasProtocolTransition = currentExecution.protocolVersion === 2
      && Boolean(executionResult.rows[0].transitioned_at);
    const unfinishedStage = currentExecution.protocolVersion === 2
      && input.status === 'succeeded'
      && !hasProtocolTransition;
    const archivedResult = await finalizeExecutionForArchivedTask(
      store, client, loaded.task, loaded.boardArchivedAt, currentExecution, completionInput,
    );
    if (archivedResult) return archivedResult;

    const workflowFacts = await loadWorkflowFacts(store, client, loaded.task);
    const executionSucceeded = await applyExecutionTaskCompletion(
      store, client, identity, loaded.task, currentExecution, executionResult.rows[0].created_at, completionInput,
    );
    if (currentExecution.protocolVersion === 2 && !hasProtocolTransition
      && (completionInput.status === 'failed' || completionInput.status === 'cancelled')
      && !workflowFacts.hasMergeFact
      && loaded.task.status !== 'done' && loaded.task.status !== 'canceled') {
      let failedCount = 0;
      let maxRetries = 3;
      if (completionInput.status === 'failed') {
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
        failedCount = Number(retryPolicy.rows[0]?.failed_count ?? 0);
        maxRetries = Math.max(0, Number(retryPolicy.rows[0]?.max_retries ?? 3));
      }
      const recovery = unresolvedExecutionRecovery(
        currentExecution.purpose,
        completionInput.status,
        failedCount,
        maxRetries,
        {
          agentFirstIntegration: loaded.task.kind === 'integration'
            && loaded.task.workflowVersion === 3,
        },
      );
      const retryStatus = recovery.status;
      const exhausted = recovery.exhausted;
      const sortOrder = retryStatus === loaded.task.status
        ? loaded.task.sortOrder
        : await nextTaskColumnSortOrder(
          store,
          client,
          identity,
          loaded.task.boardId,
          taskId,
          retryStatus,
        );
      await client.query(
        `UPDATE ${store.tasksTable}
            SET status=$2, sort_order=$3, completed_at=NULL,
                workflow_epoch=workflow_epoch+1,
                next_action=CASE
                  WHEN $2='todo' THEN 'work'
                  WHEN $2='in_review' THEN 'review'
                  WHEN $2='in_progress' THEN $4
                  ELSE 'none'
                END,
                next_action_revision=next_action_revision+1,
                version=version+1, updated_at=now()
          WHERE id=$1`,
        [taskId, retryStatus, sortOrder, currentExecution.purpose],
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

    const existingExecutionComment = await client.query(
      `SELECT c.id FROM ${store.changesTable} ch
         JOIN ${store.commentsTable} c ON c.id=ch.payload->>'commentId'
        WHERE ch.task_id=$1 AND ch.change_type='execution.comment' AND ch.actor_id=$2 LIMIT 1`,
      [taskId, runId],
    );
    if (!unfinishedStage && existingExecutionComment.rows[0]
      && (completionInput.attachments?.length ?? 0) > 0) {
      await client.query(
        `UPDATE ${store.commentsTable}
            SET attachments=$2::jsonb,version=version+1,updated_at=now()
          WHERE id=$1`,
        [String(existingExecutionComment.rows[0].id), JSON.stringify(completionInput.attachments)],
      );
    } else if (!unfinishedStage && !existingExecutionComment.rows[0]) {
      const deliveryComment = await client.query(
        `INSERT INTO ${store.commentsTable}
           (id,task_id,body,attachments,author_type,author_id,author_name,continuation_eligible,version)
         VALUES ($1,$2,$3,$4::jsonb,'agent',$5,'Agent',false,1)
         RETURNING id`,
        [randomUUID(), taskId, completionInput.commentBody.trim(),
          JSON.stringify(completionInput.attachments ?? []), runId],
      );
      await appendTaskChange(store, client, taskId, 'execution.comment', 'agent', runId, {
        commentId: String(deliveryComment.rows[0]!.id),
        automatic: true,
      });
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
    if (!unfinishedStage) {
      await enqueueAutomaticReview(
        store, client, loaded.task, currentExecution, executionSucceeded, completionInput.reviewExecution,
      );
    }
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
