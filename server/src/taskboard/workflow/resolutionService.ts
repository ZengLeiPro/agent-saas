import { randomUUID } from 'node:crypto';

import type {
  TaskBoardExecutionResolutionInput,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { rowToExecution } from '../storeHelpers.js';
import {
  appendChange,
  enqueueOnReadyTrigger,
  loadAccessibleTaskAndBoard,
  loadTask,
  type TaskboardV2StoreOptions,
  withTransaction,
} from '../v2Store.js';
import { assertWorkflowOutcome, resolveWorkflowContract } from '../workflowContract.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from '../types.js';
import {
  assertReceiptBoundToExecution,
  assertReceiptIdentityBoundToExecution,
  insertResolution,
  loadWorkflowFacts,
} from './commandService.js';
import { decideResolution } from './decider.js';

export async function resolveExecutionV2(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  runId: string,
  input: TaskBoardExecutionResolutionInput,
): Promise<TaskBoardTask> {
  return withTransaction(options, async (client) => {
    const ownershipResult = await client.query(
      `SELECT e.task_id
         FROM ${options.executionsTable} e
         JOIN ${options.tasksTable} t ON t.id=e.task_id
         JOIN ${options.boardsTable} b ON b.id=t.board_id
        WHERE e.run_id=$1 AND b.tenant_id=$2
          AND (b.owner_user_id=$3 OR b.visibility='organization')`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    if (!ownershipResult.rows[0]) throw new TaskboardNotFoundError('Taskboard execution not found');
    const taskId = String(ownershipResult.rows[0].task_id);
    if (input.receipt.taskId !== taskId) {
      throw new TaskboardValidationError('Context receipt belongs to another task', 'TASKBOARD_CONTEXT_STALE');
    }
    // 全局锁序：Task -> Source/Attempt -> Execution。
    const loaded = await loadAccessibleTaskAndBoard(options, client, identity, taskId, true);
    let remediationApproval: { sourceId: string; attemptId: string; integrationTaskId: string } | undefined;
    if (loaded.task.kind === 'remediation' && input.outcome === 'approved') {
      const relation = await client.query(
        `SELECT s.id AS source_id,s.integration_task_id,a.id AS attempt_id
           FROM ${options.remediationAttemptsTable} a
           JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id
          WHERE a.remediation_task_id=$1 AND a.state='active'
            AND s.remediation_task_id=$1 AND s.state='waiting_remediation'
          FOR UPDATE OF s,a`,
        [taskId],
      );
      if (relation.rows.length !== 1) {
        throw new TaskboardValidationError(
          'Remediation approval requires exactly one active source attempt',
          'TASKBOARD_REMEDIATION_SOURCE_REQUIRED',
        );
      }
      remediationApproval = {
        sourceId: String(relation.rows[0].source_id),
        attemptId: String(relation.rows[0].attempt_id),
        integrationTaskId: String(relation.rows[0].integration_task_id),
      };
    }
    const executionResult = await client.query(
      `SELECT e.*,t.workflow_epoch
         FROM ${options.executionsTable} e
         JOIN ${options.tasksTable} t ON t.id=e.task_id
        WHERE e.run_id=$1 FOR UPDATE OF e`,
      [runId],
    );
    const executionRow = executionResult.rows[0];
    if (!executionRow) throw new TaskboardNotFoundError('Taskboard execution not found');
    const execution = rowToExecution(executionRow);
    const existingResolution = await client.query(
      `SELECT 1 FROM ${options.resolutionsTable} WHERE execution_id=$1 LIMIT 1`,
      [execution.id],
    );
    if (existingResolution.rows[0]) {
      await insertResolution(options, client, loaded.task, execution, input, { applied: false });
      return loaded.task;
    }
    const facts = await loadWorkflowFacts(options, client, loaded.task);
    if (facts.hasMergeFact) {
      assertReceiptIdentityBoundToExecution(execution, input);
      assertWorkflowOutcome(resolveWorkflowContract(loaded.task, execution.purpose), input.outcome);
      const ignored = await insertResolution(options, client, loaded.task, execution, input, {
        applied: false,
        ignoredReason: 'merged_terminal',
      });
      if (!ignored.replay) {
        await appendChange(options, client, taskId, 'execution.receipt_ignored', 'system', runId, {
          executionId: execution.id,
          resolutionId: ignored.resolutionId,
          outcome: input.outcome,
          reason: 'merged_terminal',
          receiptFenceEpoch: input.receipt.fenceEpoch,
          currentFenceEpoch: execution.fenceEpoch ?? '0',
        });
      }
      return loaded.task;
    }
    if (!['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(executionRow.status))
      || execution.supersededAt || execution.resolvedAt) {
      throw new TaskboardValidationError('Taskboard execution is no longer active', 'TASKBOARD_EXECUTION_FENCED');
    }
    assertReceiptBoundToExecution(execution, input, String(executionRow.workflow_epoch ?? 0));
    const maxSeqResult = await client.query(
      `SELECT COALESCE(MAX(seq),0)::text AS seq FROM ${options.changesTable} WHERE task_id=$1`,
      [taskId],
    );
    const maxSeq = String(maxSeqResult.rows[0]?.seq ?? '0');
    const contract = resolveWorkflowContract(loaded.task, rowToExecution(executionRow).purpose);
    const policy = jsonObject(loaded.board.integration_policy) as { revision?: string } | undefined;
    if (
      loaded.task.version !== input.receipt.taskVersion
      || maxSeq !== input.receipt.changeSeq
      || contract.digest !== input.receipt.contractDigest
      || (policy?.revision ?? 'none') !== input.receipt.policyRevision
      || (loaded.task.reviewedSubjectDigest ?? undefined) !== input.receipt.subjectDigest
    ) {
      throw new TaskboardValidationError(
        'Task context changed; read the latest context before resolving',
        'TASKBOARD_CONTEXT_STALE',
      );
    }
    assertWorkflowOutcome(contract, input.outcome);
    if (contract.purpose === 'work' && input.outcome === 'ready_for_review' && !loaded.task.providerPullRequestId) {
      throw new TaskboardValidationError(
        'Delivery work must attach its pull request before completion',
        'TASKBOARD_PULL_REQUEST_REQUIRED',
      );
    }
    if (contract.purpose === 'review' && input.outcome === 'approved' && !loaded.task.reviewedSubjectDigest) {
      throw new TaskboardValidationError(
        'Review must record the exact pull request subject before approval',
        'TASKBOARD_REVIEW_SUBJECT_REQUIRED',
      );
    }
    const workflowDecision = decideResolution(loaded.task, contract.purpose, input.outcome, facts);
    if (workflowDecision.kind === 'ignore') return loaded.task;
    const nextStatus = workflowDecision.toStatus;
    const canonical = await insertResolution(options, client, loaded.task, execution, input, {
      applied: true,
      ...(nextStatus ? { toStatus: nextStatus } : {}),
    });
    if (canonical.replay) return loaded.task;
    if (input.outcome === 'approved' && loaded.task.kind === 'remediation') {
      if (!remediationApproval) {
        throw new TaskboardValidationError(
          'Remediation approval lost its source attempt',
          'TASKBOARD_REMEDIATION_SOURCE_REQUIRED',
        );
      }
      const resumed = await client.query(
        `UPDATE ${options.integrationSourcesTable}
            SET state='pending', remediation_task_id=NULL,last_error=NULL,updated_at=now()
          WHERE id=$1 AND state='waiting_remediation' AND remediation_task_id=$2
          RETURNING id`,
        [remediationApproval.sourceId, taskId],
      );
      if (!resumed.rows[0]) {
        throw new TaskboardValidationError(
          'Remediation source changed before approval was applied',
          'TASKBOARD_CONTEXT_STALE',
        );
      }
      const resolvedAttempt = await client.query(
        `UPDATE ${options.remediationAttemptsTable}
            SET state='resolved',resolved_at=now()
          WHERE id=$1 AND state='active'
          RETURNING id`,
        [remediationApproval.attemptId],
      );
      if (!resolvedAttempt.rows[0]) {
        throw new TaskboardValidationError(
          'Remediation attempt changed before approval was applied',
          'TASKBOARD_CONTEXT_STALE',
        );
      }
      await appendChange(options, client, remediationApproval.integrationTaskId, 'integration.remediation_completed', 'agent', identity.ownerUserId, {
        sourceId: remediationApproval.sourceId,
        remediationTaskId: taskId,
        attemptId: remediationApproval.attemptId,
      });
    }
    if (input.outcome === 'completed' && loaded.task.kind === 'integration') {
      const remaining = await client.query(
        `SELECT 1 FROM ${options.integrationSourcesTable}
          WHERE integration_task_id=$1 AND state<>'merged' LIMIT 1`,
        [taskId],
      );
      if (remaining.rows[0]) {
        throw new TaskboardValidationError(
          'Integration task still has unmerged sources',
          'TASKBOARD_INTEGRATION_INCOMPLETE',
        );
      }
    }
    if (nextStatus) {
      await client.query(
        `UPDATE ${options.tasksTable}
            SET status=$2, completed_at=CASE WHEN $2='done' THEN now() ELSE NULL END,
                workflow_epoch=workflow_epoch+1,
                next_action=CASE
                  WHEN $2='todo' THEN 'work'
                  WHEN $2='in_review' THEN 'review'
                  WHEN $2='ready_to_merge' THEN 'merge'
                  ELSE 'none'
                END,
                next_action_revision=next_action_revision+1,
                version=version+1, updated_at=now()
          WHERE id=$1`,
        [taskId, nextStatus],
      );
    }
    if (input.outcome === 'needs_human' || input.outcome === 'blocked') {
      await client.query(
        `INSERT INTO ${options.blockEpisodesTable}
           (id, task_id, purpose, execution_id, reason_code, reason)
         VALUES ($1,$2,$3,$4,'agent_needs_human',$5)`,
        [randomUUID(), taskId, contract.purpose, executionRow.id, input.summary],
      );
    }
    if (input.outcome === 'completed' && loaded.task.kind === 'integration') {
      await client.query(
        `UPDATE ${options.mergeAuthorizationsTable} SET revoked_at=now()
          WHERE integration_task_id=$1 AND revoked_at IS NULL`,
        [taskId],
      );
      const repository = jsonObject(loaded.board.repository) as { repositoryId?: string } | undefined;
      if (repository?.repositoryId) {
        await client.query(
          `UPDATE ${options.integrationLanesTable}
              SET active_integration_task_id=NULL, lease_id=NULL, updated_at=now()
            WHERE repository_id=$1 AND active_integration_task_id=$2`,
          [repository.repositoryId, taskId],
        );
      }
    }
    await client.query(
      `INSERT INTO ${options.commentsTable}
         (id, task_id, body, author_type, author_id, author_name, continuation_eligible, version)
       VALUES ($1,$2,$3,'agent',$4,'Agent',false,1)`,
      [randomUUID(), taskId, input.summary, identity.ownerUserId],
    );
    await appendChange(options, client, taskId, 'execution.resolved.v2', 'agent', identity.ownerUserId, {
      schemaVersion: 2,
      commandId: canonical.resolutionId,
      resolutionId: canonical.resolutionId,
      executionId: execution.id,
      attemptId: execution.attemptId ?? execution.id,
      runId,
      outcome: input.outcome,
      summary: input.summary,
      evidence: input.evidence ?? [],
      receipt: input.receipt,
    });
    if (input.outcome === 'approved' && loaded.task.kind === 'delivery') {
      await enqueueOnReadyTrigger(options, client, loaded.board, taskId);
    }
    return loadTask(options, client, taskId);
  });
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
