import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardExecution,
  TaskBoardExecutionTransitionInput,
  TaskBoardIntegrationCandidateState,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { integrationCandidateTableNames } from '../integrationCandidateSchema.js';
import { rowToExecution } from '../storeHelpers.js';
import {
  appendChange,
  enqueueOnReadyTrigger,
  loadAccessibleTaskAndBoard,
  loadTask,
  type TaskboardV2StoreOptions,
  withTransaction,
} from '../v2Store.js';
import { TaskboardNotFoundError, TaskboardValidationError, type TaskboardIdentity } from '../types.js';
import { loadWorkflowFacts } from './commandService.js';
import { decideTransition, isCurrentIntegrationV3Execution, type IntegrationV3ExecutionBinding, type IntegrationV3Facts } from './decider.js';

const ACTIVE = ['queued', 'running', 'waiting_user', 'waiting_approval'];

export async function transitionExecutionV2(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  runId: string,
  input: TaskBoardExecutionTransitionInput,
): Promise<TaskBoardTask> {
  return withTransaction(options, async (client) => {
    const ownership = await client.query(
      `SELECT e.task_id FROM ${options.executionsTable} e
       JOIN ${options.tasksTable} t ON t.id=e.task_id
       JOIN ${options.boardsTable} b ON b.id=t.board_id
       WHERE e.run_id=$1 AND b.tenant_id=$2
         AND (b.owner_user_id=$3 OR b.visibility='organization')`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    if (!ownership.rows[0]) throw new TaskboardNotFoundError('Taskboard execution not found');
    const taskId = String(ownership.rows[0].task_id);
    // Global lock order: Task -> Source/Attempt -> Execution.
    const loaded = await loadAccessibleTaskAndBoard(options, client, identity, taskId, true);
    let remediationApproval: { sourceId: string; attemptId: string; integrationTaskId: string } | undefined;
    if (loaded.task.kind === 'remediation' && input.status === 'done') {
      const relation = await client.query(
        `SELECT s.id AS source_id,s.integration_task_id,a.id AS attempt_id
         FROM ${options.remediationAttemptsTable} a
         JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id
         WHERE a.remediation_task_id=$1 AND a.state='active'
           AND s.remediation_task_id=$1 AND s.state='waiting_remediation'
         FOR UPDATE OF s,a`, [taskId]);
      if (relation.rows.length !== 1) {
        throw new TaskboardValidationError('Remediation approval requires exactly one active source attempt', 'TASKBOARD_REMEDIATION_SOURCE_REQUIRED');
      }
      remediationApproval = {
        sourceId: String(relation.rows[0].source_id),
        attemptId: String(relation.rows[0].attempt_id),
        integrationTaskId: String(relation.rows[0].integration_task_id),
      };
    }
    const executionResult = await client.query(
      `SELECT e.* FROM ${options.executionsTable} e WHERE e.run_id=$1 FOR UPDATE`, [runId]);
    const executionRow = executionResult.rows[0] as Record<string, unknown> | undefined;
    if (!executionRow) throw new TaskboardNotFoundError('Taskboard execution not found');
    const execution = rowToExecution(executionRow);
    assertActiveExecution(executionRow, execution);
    await assertExecutionComment(options, client, execution);

    if (loaded.task.kind === 'integration' && loaded.task.workflowVersion === 3) {
      return transitionIntegrationV3(options, client, identity, loaded.task, execution, executionRow, input.status);
    }
    const facts = await loadWorkflowFacts(options, client, loaded.task);
    const completingMergedIntegration = loaded.task.kind === 'integration'
      && loaded.task.workflowVersion !== 3
      && execution.purpose === 'merge'
      && input.status === 'done';
    if (loaded.task.status === 'done' || loaded.task.status === 'canceled'
      || (facts.hasMergeFact && !completingMergedIntegration)) {
      throw new TaskboardValidationError('Expired or terminal execution cannot transition the task', 'TASKBOARD_EXECUTION_FENCED');
    }
    if (completingMergedIntegration && !facts.hasMergeFact) {
      throw new TaskboardValidationError('Integration task has no complete merge fact', 'TASKBOARD_INTEGRATION_INCOMPLETE');
    }
    const decision = decideTransition(loaded.task, execution.purpose, input.status, facts);
    const nextStatus = decision.toStatus;
    if (!nextStatus) throw new TaskboardValidationError('Transition does not advance task state', 'TASKBOARD_WORKFLOW_TRANSITION_INVALID');

    if (execution.purpose === 'work' && loaded.task.kind !== 'advisory'
      && nextStatus === 'in_review' && !loaded.task.providerPullRequestId) {
      throw new TaskboardValidationError('Delivery work must attach its pull request before review', 'TASKBOARD_PULL_REQUEST_REQUIRED');
    }
    if (execution.purpose === 'review' && nextStatus === 'ready_to_merge' && !loaded.task.reviewedSubjectDigest) {
      throw new TaskboardValidationError('Review must record the exact pull request subject before approval', 'TASKBOARD_REVIEW_SUBJECT_REQUIRED');
    }
    if (loaded.task.kind === 'remediation' && execution.purpose === 'work' && nextStatus === 'in_review') {
      if (!await recordRemediationCommit(options, client, taskId, execution.id)) {
        throw new TaskboardValidationError('Remediation work must produce a new commit before entering review', 'TASKBOARD_REMEDIATION_COMMIT_REQUIRED');
      }
    }
    if (remediationApproval) {
      const resumed = await client.query(
        `UPDATE ${options.integrationSourcesTable} SET state='pending',remediation_task_id=NULL,last_error=NULL,updated_at=now()
         WHERE id=$1 AND state='waiting_remediation' AND remediation_task_id=$2 RETURNING id`,
        [remediationApproval.sourceId, taskId]);
      if (!resumed.rows[0]) throw new TaskboardValidationError('Remediation source changed before approval', 'TASKBOARD_CONTEXT_STALE');
      const attempt = await client.query(
        `UPDATE ${options.remediationAttemptsTable} SET state='resolved',resolved_at=now()
         WHERE id=$1 AND state='active' RETURNING id`, [remediationApproval.attemptId]);
      if (!attempt.rows[0]) throw new TaskboardValidationError('Remediation attempt changed before approval', 'TASKBOARD_CONTEXT_STALE');
      await appendChange(options, client, remediationApproval.integrationTaskId, 'integration.remediation_completed', 'agent', identity.ownerUserId, {
        sourceId: remediationApproval.sourceId, remediationTaskId: taskId, attemptId: remediationApproval.attemptId,
      });
    }
    await updateTaskStatus(options, client, taskId, nextStatus);
    if (nextStatus === 'blocked') await recordBlock(options, client, taskId, execution);
    if (loaded.task.kind === 'integration' && nextStatus === 'done') await closeIntegration(options, client, loaded.task, loaded.board.repository);
    await markTransitioned(options, client, execution, input.status);
    await appendChange(options, client, taskId, 'execution.transitioned', 'agent', identity.ownerUserId, {
      executionId: execution.id, runId, purpose: execution.purpose, fromStatus: loaded.task.status, status: nextStatus,
    });
    if (execution.purpose === 'review' && nextStatus === 'ready_to_merge' && loaded.task.kind === 'delivery') {
      await enqueueOnReadyTrigger(options, client, loaded.board, taskId);
    }
    return loadTask(options, client, taskId);
  });
}

async function transitionIntegrationV3(
  options: TaskboardV2StoreOptions, client: PoolClient, identity: TaskboardIdentity,
  task: TaskBoardTask, execution: TaskBoardExecution, executionRow: Record<string, unknown>, status: TaskBoardTask['status'],
): Promise<TaskBoardTask> {
  const { candidatesTable, revisionsTable } = integrationCandidateTableNames(options.integrationSourcesTable);
  const result = await client.query(
    `SELECT c.*,r.head_oid,r.subject_digest FROM ${candidatesTable} c
     LEFT JOIN ${revisionsTable} r ON r.candidate_id=c.id AND r.revision=c.current_revision
     WHERE c.integration_task_id=$1 FOR UPDATE OF c`, [task.id]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new TaskboardValidationError('Workflow v3 integration task has no candidate', 'TASKBOARD_CANDIDATE_REQUIRED');
  const candidate: IntegrationV3Facts = {
    id: String(row.id), state: String(row.state) as TaskBoardIntegrationCandidateState,
    version: Number(row.version), currentRevision: Number(row.current_revision), workRound: Number(row.work_round),
    workflowEpoch: String(row.workflow_epoch), laneEpoch: String(row.lane_epoch),
    ...(row.head_oid ? { headOid: String(row.head_oid) } : {}),
  };
  const binding = executionBinding(executionRow);
  if (!binding || !candidate.headOid || !row.subject_digest || !isCurrentIntegrationV3Execution(candidate, binding)) {
    throw new TaskboardValidationError('Candidate changed or execution binding expired', 'TASKBOARD_EXECUTION_FENCED');
  }
  const decision = decideTransition(task, execution.purpose, status, { hasMergeFact: false, candidate, executionBinding: binding });
  if (decision.requestSystemReview) {
    await markTransitioned(options, client, execution, status);
    await appendChange(options, client, task.id, 'integration.candidate_review_requested', 'agent', identity.ownerUserId, {
      schemaVersion: 3, executionId: execution.id, runId: execution.runId, purpose: execution.purpose,
      status, candidateId: candidate.id, candidateRevision: candidate.currentRevision, candidateHeadOid: candidate.headOid,
      candidateWorkRound: candidate.workRound, workflowEpoch: candidate.workflowEpoch, laneEpoch: candidate.laneEpoch,
      reconcileRequired: true, reviewRequested: true,
    });
    return loadTask(options, client, task.id);
  }
  if (!decision.toStatus || !decision.candidateState) {
    throw new TaskboardValidationError('Workflow v3 transition is incomplete', 'TASKBOARD_WORKFLOW_TRANSITION_INVALID');
  }
  const approved = decision.candidateState === 'approved';
  const updated = await client.query(
    `UPDATE ${candidatesTable} SET state=$8,
       approved_revision=CASE WHEN $9::boolean THEN current_revision ELSE NULL END,
       approved_review_execution_id=CASE WHEN $9::boolean THEN $7 ELSE NULL END,
       last_error=CASE WHEN $8='blocked' THEN 'Agent transitioned candidate to blocked' ELSE NULL END,
       workflow_epoch=workflow_epoch+1,version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND current_revision=$3 AND work_round=$4
       AND workflow_epoch=$5::bigint AND lane_epoch=$6::bigint AND state=$10 RETURNING workflow_epoch`,
    [candidate.id, candidate.version, candidate.currentRevision, candidate.workRound, candidate.workflowEpoch,
      candidate.laneEpoch, execution.id, decision.candidateState, approved, candidate.state]);
  if (!updated.rows[0]) throw new TaskboardValidationError('Candidate changed before transition', 'TASKBOARD_CANDIDATE_CAS_MISMATCH');
  await updateTaskStatus(options, client, task.id, decision.toStatus);
  if (decision.toStatus === 'blocked') await recordBlock(options, client, task.id, execution);
  await markTransitioned(options, client, execution, status);
  await appendChange(options, client, task.id, 'execution.transitioned.v3', 'agent', identity.ownerUserId, {
    schemaVersion: 3, executionId: execution.id, runId: execution.runId, purpose: execution.purpose, status: decision.toStatus,
    candidateId: candidate.id, candidateRevision: candidate.currentRevision, candidateHeadOid: candidate.headOid,
    candidateWorkRound: candidate.workRound, workflowEpoch: String(updated.rows[0].workflow_epoch), laneEpoch: candidate.laneEpoch,
  });
  return loadTask(options, client, task.id);
}

function assertActiveExecution(row: Record<string, unknown>, execution: TaskBoardExecution): void {
  if (!ACTIVE.includes(String(row.status)) || row.transitioned_at || execution.supersededAt) {
    throw new TaskboardValidationError('Taskboard execution is no longer active', 'TASKBOARD_EXECUTION_FENCED');
  }
}

async function assertExecutionComment(options: TaskboardV2StoreOptions, client: PoolClient, execution: TaskBoardExecution): Promise<void> {
  const comment = await client.query(
    `SELECT 1 FROM ${options.commentsTable} c
     JOIN ${options.changesTable} ch ON ch.task_id=c.task_id AND ch.change_type='execution.comment'
       AND ch.payload->>'commentId'=c.id
     WHERE c.task_id=$1 AND ch.actor_id=$2 LIMIT 1`, [execution.taskId, execution.runId]);
  if (!comment.rows[0]) throw new TaskboardValidationError(
    'Write an Agent comment with execution.comment before transitioning', 'TASKBOARD_EXECUTION_COMMENT_REQUIRED');
}

async function markTransitioned(options: TaskboardV2StoreOptions, client: PoolClient, execution: TaskBoardExecution, status: string): Promise<void> {
  const updated = await client.query(
    `UPDATE ${options.executionsTable} SET transitioned_at=now(),fence_epoch=fence_epoch+1,
       terminal_reason_code='execution_transitioned',updated_at=now()
     WHERE id=$1 AND transitioned_at IS NULL RETURNING id`, [execution.id]);
  if (!updated.rows[0]) throw new TaskboardValidationError(`Execution already transitioned to ${status}`, 'TASKBOARD_EXECUTION_FENCED');
}

async function updateTaskStatus(options: TaskboardV2StoreOptions, client: PoolClient, taskId: string, status: string): Promise<void> {
  await client.query(
    `UPDATE ${options.tasksTable} SET status=$2,completed_at=CASE WHEN $2='done' THEN now() ELSE NULL END,
       workflow_epoch=workflow_epoch+1,next_action=CASE WHEN $2='todo' THEN 'work' WHEN $2='in_review' THEN 'review'
       WHEN $2='ready_to_merge' THEN 'merge' ELSE 'none' END,next_action_revision=next_action_revision+1,
       version=version+1,updated_at=now() WHERE id=$1`, [taskId, status]);
}

async function recordBlock(options: TaskboardV2StoreOptions, client: PoolClient, taskId: string, execution: TaskBoardExecution): Promise<void> {
  await client.query(
    `INSERT INTO ${options.blockEpisodesTable}(id,task_id,purpose,execution_id,reason_code,reason)
     VALUES ($1,$2,$3,$4,'agent_needs_human','See the execution Agent comment')`,
    [randomUUID(), taskId, execution.purpose, execution.id]);
}

async function closeIntegration(options: TaskboardV2StoreOptions, client: PoolClient, task: TaskBoardTask, repositoryRaw: unknown): Promise<void> {
  await client.query(`UPDATE ${options.mergeAuthorizationsTable} SET revoked_at=now() WHERE integration_task_id=$1 AND revoked_at IS NULL`, [task.id]);
  const repository = jsonObject(repositoryRaw) as { repositoryId?: string } | undefined;
  if (repository?.repositoryId) await client.query(
    `UPDATE ${options.integrationLanesTable} SET active_integration_task_id=NULL,lease_id=NULL,updated_at=now()
     WHERE repository_id=$1 AND active_integration_task_id=$2`, [repository.repositoryId, task.id]);
}

function executionBinding(row: Record<string, unknown>): IntegrationV3ExecutionBinding | undefined {
  if (!row.candidate_id || row.candidate_version == null || row.candidate_revision == null || row.candidate_work_round == null
    || row.candidate_workflow_epoch == null || row.candidate_lane_epoch == null || !row.candidate_head_oid) return undefined;
  return {
    candidateId: String(row.candidate_id), candidateVersion: Number(row.candidate_version),
    candidateRevision: Number(row.candidate_revision), candidateWorkRound: Number(row.candidate_work_round),
    candidateWorkflowEpoch: String(row.candidate_workflow_epoch), candidateLaneEpoch: String(row.candidate_lane_epoch),
    candidateHeadOid: String(row.candidate_head_oid),
  };
}

async function recordRemediationCommit(options: TaskboardV2StoreOptions, client: PoolClient, remediationTaskId: string, executionId: string): Promise<boolean> {
  const locked = await client.query(
    `SELECT a.id,a.integration_source_id,a.base_head_oid,a.completed_head_oid,s.integration_task_id,
       d.head_oid AS delivery_head_oid,r.head_oid AS remediation_head_oid
     FROM ${options.remediationAttemptsTable} a
     JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id
     JOIN ${options.tasksTable} d ON d.id=s.delivery_task_id JOIN ${options.tasksTable} r ON r.id=a.remediation_task_id
     WHERE a.remediation_task_id=$1 AND a.state='active' AND s.remediation_task_id=$1 AND s.state='waiting_remediation'
     FOR UPDATE OF s,a`, [remediationTaskId]);
  const row = locked.rows[0];
  if (!row) return true;
  const headOid = row.remediation_head_oid ? String(row.remediation_head_oid) : '';
  const baseline = row.base_head_oid ?? row.delivery_head_oid;
  if (!headOid || headOid === baseline || headOid === row.completed_head_oid) return false;
  const attempt = await client.query(
    `UPDATE ${options.remediationAttemptsTable} SET completed_head_oid=$2
     WHERE id=$1 AND state='active' AND completed_head_oid IS DISTINCT FROM $2 RETURNING id`, [row.id, headOid]);
  if (!attempt.rows[0]) throw new TaskboardValidationError('Remediation attempt changed', 'TASKBOARD_CONTEXT_STALE');
  const source = await client.query(
    `UPDATE ${options.integrationSourcesTable} SET remediation_count=remediation_count+1,updated_at=now()
     WHERE id=$1 AND state='waiting_remediation' AND remediation_task_id=$2 RETURNING integration_task_id,remediation_count`,
    [row.integration_source_id, remediationTaskId]);
  if (!source.rows[0]) throw new TaskboardValidationError('Remediation source changed', 'TASKBOARD_CONTEXT_STALE');
  await appendChange(options, client, String(source.rows[0].integration_task_id), 'integration.remediation_commit_recorded', 'agent', executionId, {
    sourceId: String(row.integration_source_id), remediationTaskId, attemptId: String(row.id), headOid,
    remediationCount: Number(source.rows[0].remediation_count),
  });
  return true;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
