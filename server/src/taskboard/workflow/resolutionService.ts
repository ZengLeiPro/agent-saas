import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardExecution,
  TaskBoardExecutionResolutionInput,
  TaskBoardIntegrationCandidateState,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { integrationCandidateTableNames } from '../integrationCandidateSchema.js';
import { assertPullRequestGate } from '../deliveryPullRequests.js';
import type { RepositoryPullRequestSnapshot } from '../repositoryProvider.js';
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
import {
  decideResolution,
  type IntegrationV3ExecutionBinding,
  type IntegrationV3Facts,
} from './decider.js';

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
    if (loaded.task.kind === 'integration' && loaded.task.workflowVersion === 3) {
      return resolveIntegrationV3Execution(
        options, client, identity, loaded.task, runId, execution, executionRow, input,
      );
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
    let verifiedPullRequest: RepositoryPullRequestSnapshot | undefined;
    if ((contract.purpose === 'work' && input.outcome === 'ready_for_review')
      || (contract.purpose === 'review' && input.outcome === 'approved')) {
      verifiedPullRequest = await assertCurrentPullRequestGate(
        options,
        client,
        loaded.task,
        loaded.board,
        execution.id,
        contract.purpose,
      );
    }
    if (loaded.task.kind === 'remediation' && input.outcome === 'ready_for_review') {
      const hasNewCommit = await recordRemediationCommit(options, client, taskId, execution.id);
      if (!hasNewCommit) {
        throw new TaskboardValidationError(
          'Remediation work must produce a new commit before entering review',
          'TASKBOARD_REMEDIATION_COMMIT_REQUIRED',
        );
      }
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
                provider_ci_execution_id=CASE WHEN $3::text IS NULL THEN provider_ci_execution_id ELSE $3 END,
                provider_ci_purpose=CASE WHEN $3::text IS NULL THEN provider_ci_purpose ELSE $4 END,
                provider_ci_head_oid=CASE WHEN $3::text IS NULL THEN provider_ci_head_oid ELSE $5 END,
                provider_ci_status=CASE WHEN $3::text IS NULL THEN provider_ci_status ELSE 'success' END,
                provider_ci_inspected_at=CASE WHEN $3::text IS NULL THEN provider_ci_inspected_at ELSE now() END,
                next_action_revision=next_action_revision+1,
                version=version+1, updated_at=now()
          WHERE id=$1`,
        [taskId, nextStatus, verifiedPullRequest ? execution.id : null,
          verifiedPullRequest ? contract.purpose : null, verifiedPullRequest?.headOid ?? null],
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

async function resolveIntegrationV3Execution(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  identity: TaskboardIdentity,
  task: TaskBoardTask,
  runId: string,
  execution: TaskBoardExecution,
  executionRow: Record<string, unknown>,
  input: TaskBoardExecutionResolutionInput,
): Promise<TaskBoardTask> {
  const { candidatesTable, revisionsTable } = integrationCandidateTableNames(options.integrationSourcesTable);
  const result = await client.query(
    `SELECT c.*,r.head_oid,r.subject_digest
       FROM ${candidatesTable} c
       LEFT JOIN ${revisionsTable} r
         ON r.candidate_id=c.id AND r.revision=c.current_revision
      WHERE c.integration_task_id=$1
      FOR UPDATE OF c`,
    [task.id],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new TaskboardValidationError(
      'Workflow v3 integration task has no candidate',
      'TASKBOARD_CANDIDATE_REQUIRED',
    );
  }
  const candidate: IntegrationV3Facts = {
    id: String(row.id),
    state: String(row.state) as TaskBoardIntegrationCandidateState,
    version: Number(row.version),
    currentRevision: Number(row.current_revision),
    workRound: Number(row.work_round),
    workflowEpoch: String(row.workflow_epoch),
    laneEpoch: String(row.lane_epoch),
    ...(row.head_oid ? { headOid: String(row.head_oid) } : {}),
  };
  const binding = executionBinding(executionRow);
  const active = ['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(executionRow.status))
    && !execution.supersededAt && !execution.resolvedAt;
  assertReceiptIdentityBoundToExecution(execution, input);
  const decision = decideResolution(task, execution.purpose, input.outcome, {
    hasMergeFact: candidate.state === 'merged',
    candidate,
    executionBinding: active ? binding : undefined,
  });
  if (decision.kind === 'ignore') {
    const ignored = await insertResolution(options, client, task, execution, input, {
      applied: false,
      ignoredReason: decision.reason,
    });
    if (!ignored.replay) {
      await appendChange(options, client, task.id, 'execution.receipt_ignored', 'system', runId, {
        executionId: execution.id,
        resolutionId: ignored.resolutionId,
        outcome: input.outcome,
        reason: decision.reason,
        candidateId: candidate.id,
        boundRevision: binding?.candidateRevision,
        currentRevision: candidate.currentRevision,
        boundWorkflowEpoch: binding?.candidateWorkflowEpoch,
        currentWorkflowEpoch: candidate.workflowEpoch,
        boundLaneEpoch: binding?.candidateLaneEpoch,
        currentLaneEpoch: candidate.laneEpoch,
      });
    }
    return task;
  }
  if (!binding || !candidate.headOid || !row.subject_digest) {
    throw new TaskboardValidationError(
      'Workflow v3 execution is missing candidate revision/head binding',
      'TASKBOARD_CANDIDATE_EXECUTION_BINDING_REQUIRED',
    );
  }
  assertReceiptBoundToExecution(execution, input, String(executionRow.workflow_epoch ?? 0));
  const contract = resolveWorkflowContract(task, execution.purpose, { candidateState: candidate.state });
  const maxSeqResult = await client.query(
    `SELECT COALESCE(MAX(seq),0)::text AS seq FROM ${options.changesTable} WHERE task_id=$1`,
    [task.id],
  );
  const policy = jsonObject((await client.query(
    `SELECT integration_policy FROM ${options.boardsTable} WHERE id=$1`, [task.boardId],
  )).rows[0]?.integration_policy) as { revision?: string } | undefined;
  if (task.version !== input.receipt.taskVersion
    || String(maxSeqResult.rows[0]?.seq ?? '0') !== input.receipt.changeSeq
    || contract.digest !== input.receipt.contractDigest
    || (policy?.revision ?? 'none') !== input.receipt.policyRevision
    || String(row.subject_digest) !== input.receipt.subjectDigest) {
    throw new TaskboardValidationError(
      'Candidate context changed; read the latest context before resolving',
      'TASKBOARD_CONTEXT_STALE',
    );
  }
  assertWorkflowOutcome(contract, input.outcome);
  if (decision.requestSystemReview) {
    const canonical = await insertResolution(options, client, task, execution, input, { applied: true });
    if (!canonical.replay) {
      await appendChange(options, client, task.id, 'integration.candidate_review_requested',
        'agent', identity.ownerUserId, {
          schemaVersion: 3,
          resolutionId: canonical.resolutionId,
          executionId: execution.id,
          runId,
          purpose: execution.purpose,
          outcome: input.outcome,
          summary: input.summary,
          evidence: input.evidence ?? [],
          candidateId: candidate.id,
          candidateRevision: candidate.currentRevision,
          candidateHeadOid: candidate.headOid,
          candidateWorkRound: candidate.workRound,
          workflowEpoch: candidate.workflowEpoch,
          laneEpoch: candidate.laneEpoch,
          reconcileRequired: true,
          reviewRequested: true,
        });
    }
    // integrationTriggers must reconcile the provider head, append a revision
    // when the subject changed, and only then move/dispatch canonical review.
    return loadTask(options, client, task.id);
  }
  const nextStatus = decision.toStatus;
  const nextCandidateState = decision.candidateState;
  if (!nextStatus || !nextCandidateState) {
    throw new TaskboardValidationError('Workflow v3 resolution is incomplete', 'TASKBOARD_WORKFLOW_TRANSITION_INVALID');
  }
  const canonical = await insertResolution(options, client, task, execution, input, {
    applied: true,
    toStatus: nextStatus,
  });
  if (canonical.replay) return task;
  const approved = nextCandidateState === 'approved';
  const candidateUpdate = await client.query(
    `UPDATE ${candidatesTable}
        SET state=$8,
            approved_revision=CASE WHEN $9::boolean THEN current_revision ELSE NULL END,
            approved_review_execution_id=CASE WHEN $9::boolean THEN $7 ELSE NULL END,
            last_error=CASE WHEN $8='blocked' THEN $10 ELSE NULL END,
            workflow_epoch=workflow_epoch+1,version=version+1,updated_at=now()
      WHERE id=$1 AND version=$2 AND current_revision=$3 AND work_round=$4
        AND workflow_epoch=$5::bigint AND lane_epoch=$6::bigint AND state=$11
      RETURNING version,workflow_epoch`,
    [candidate.id, candidate.version, candidate.currentRevision, candidate.workRound,
      candidate.workflowEpoch, candidate.laneEpoch, execution.id, nextCandidateState,
      approved, input.summary, candidate.state],
  );
  if (!candidateUpdate.rows[0]) {
    throw new TaskboardValidationError('Candidate changed before resolution was applied', 'TASKBOARD_CANDIDATE_CAS_MISMATCH');
  }
  await client.query(
    `UPDATE ${options.tasksTable}
        SET status=$2,completed_at=NULL,workflow_epoch=workflow_epoch+1,
            next_action='none',next_action_revision=next_action_revision+1,
            version=version+1,updated_at=now()
      WHERE id=$1`,
    [task.id, nextStatus],
  );
  if (input.outcome === 'blocked') {
    await client.query(
      `INSERT INTO ${options.blockEpisodesTable}
         (id,task_id,purpose,execution_id,reason_code,reason)
       VALUES ($1,$2,$3,$4,'agent_needs_human',$5)`,
      [randomUUID(), task.id, execution.purpose, execution.id, input.summary],
    );
  }
  await appendChange(options, client, task.id, 'execution.resolved.v3', 'agent', identity.ownerUserId, {
    schemaVersion: 3,
    resolutionId: canonical.resolutionId,
    executionId: execution.id,
    runId,
    purpose: execution.purpose,
    outcome: input.outcome,
    summary: input.summary,
    evidence: input.evidence ?? [],
    candidateId: candidate.id,
    candidateRevision: candidate.currentRevision,
    candidateHeadOid: candidate.headOid,
    candidateWorkRound: candidate.workRound,
    workflowEpoch: String(candidateUpdate.rows[0]!.workflow_epoch),
    laneEpoch: candidate.laneEpoch,
  });
  return loadTask(options, client, task.id);
}

function executionBinding(row: Record<string, unknown>): IntegrationV3ExecutionBinding | undefined {
  if (!row.candidate_id || row.candidate_version === null || row.candidate_version === undefined
    || row.candidate_revision === null || row.candidate_revision === undefined
    || row.candidate_work_round === null || row.candidate_work_round === undefined
    || row.candidate_workflow_epoch === null || row.candidate_workflow_epoch === undefined
    || row.candidate_lane_epoch === null || row.candidate_lane_epoch === undefined
    || !row.candidate_head_oid) return undefined;
  return {
    candidateId: String(row.candidate_id),
    candidateVersion: Number(row.candidate_version),
    candidateRevision: Number(row.candidate_revision),
    candidateWorkRound: Number(row.candidate_work_round),
    candidateWorkflowEpoch: String(row.candidate_workflow_epoch),
    candidateLaneEpoch: String(row.candidate_lane_epoch),
    candidateHeadOid: String(row.candidate_head_oid),
  };
}

async function recordRemediationCommit(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  remediationTaskId: string,
  executionId: string,
): Promise<boolean> {
  const relation = await client.query(
    `SELECT a.id,a.integration_source_id,a.base_head_oid,a.completed_head_oid,
            s.integration_task_id,s.state,s.remediation_count,s.remediation_task_id,
            d.id AS delivery_task_id,d.head_oid AS delivery_head_oid,
            r.head_oid AS remediation_head_oid
       FROM ${options.remediationAttemptsTable} a
       JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id
       JOIN ${options.tasksTable} d ON d.id=s.delivery_task_id
       JOIN ${options.tasksTable} r ON r.id=a.remediation_task_id
      WHERE a.remediation_task_id=$1 AND a.state='active'
        AND s.remediation_task_id=$1 AND s.state='waiting_remediation'`,
    [remediationTaskId],
  );
  if (!relation.rows[0]) return true;
  const locked = await client.query(
    `SELECT a.id,a.integration_source_id,a.base_head_oid,a.completed_head_oid,
            s.integration_task_id,s.state,s.remediation_count,s.remediation_task_id,
            d.head_oid AS delivery_head_oid,r.head_oid AS remediation_head_oid
       FROM ${options.remediationAttemptsTable} a
       JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id
       JOIN ${options.tasksTable} d ON d.id=s.delivery_task_id
       JOIN ${options.tasksTable} r ON r.id=a.remediation_task_id
      WHERE a.remediation_task_id=$1 AND a.state='active'
        AND s.remediation_task_id=$1 AND s.state='waiting_remediation'
      FOR UPDATE OF s,a`,
    [remediationTaskId],
  );
  const row = locked.rows[0];
  if (!row) {
    throw new TaskboardValidationError(
      'Remediation source changed before the commit check completed',
      'TASKBOARD_CONTEXT_STALE',
    );
  }
  const headOid = row.remediation_head_oid ? String(row.remediation_head_oid) : '';
  const baseline = row.base_head_oid ?? row.delivery_head_oid;
  if (!headOid || headOid === baseline || headOid === row.completed_head_oid) return false;
  const attempt = await client.query(
    `UPDATE ${options.remediationAttemptsTable}
        SET completed_head_oid=$2
      WHERE id=$1 AND state='active' AND completed_head_oid IS DISTINCT FROM $2
      RETURNING id`,
    [row.id, headOid],
  );
  if (!attempt.rows[0]) {
    throw new TaskboardValidationError(
      'Remediation attempt changed before the new commit was recorded',
      'TASKBOARD_CONTEXT_STALE',
    );
  }
  const source = await client.query(
    `UPDATE ${options.integrationSourcesTable}
        SET remediation_count=remediation_count+1,updated_at=now()
      WHERE id=$1 AND state='waiting_remediation' AND remediation_task_id=$2
      RETURNING integration_task_id,remediation_count`,
    [row.integration_source_id, remediationTaskId],
  );
  if (!source.rows[0]) {
    throw new TaskboardValidationError(
      'Remediation source changed before the new commit was recorded',
      'TASKBOARD_CONTEXT_STALE',
    );
  }
  await appendChange(options, client, String(source.rows[0].integration_task_id), 'integration.remediation_commit_recorded', 'agent', executionId, {
    sourceId: String(row.integration_source_id),
    remediationTaskId,
    attemptId: String(row.id),
    headOid,
    remediationCount: Number(source.rows[0].remediation_count),
  });
  return true;
}

export async function assertCurrentPullRequestGate(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  task: TaskBoardTask,
  board: Record<string, unknown>,
  executionId: string,
  purpose: 'work' | 'review',
): Promise<RepositoryPullRequestSnapshot> {
  const taskResult = await client.query(
    `SELECT provider_pull_request_id,head_oid,base_oid,reviewed_subject_digest,
            provider_ci_inspection_id,provider_ci_execution_id,provider_ci_purpose,
            provider_ci_head_oid,provider_ci_status
       FROM ${options.tasksTable} WHERE id=$1 FOR UPDATE`,
    [task.id],
  );
  const row = taskResult.rows[0];
  const providerPullRequestId = String(row?.provider_pull_request_id ?? '');
  const headOid = String(row?.head_oid ?? '');
  if (!providerPullRequestId || !headOid) {
    throw new TaskboardValidationError('Pull request registration lacks an exact head oid', 'TASKBOARD_PULL_REQUEST_REQUIRED');
  }
  const inspectionResult = await client.query(
    `SELECT payload FROM ${options.changesTable}
      WHERE task_id=$1 AND execution_id=$2 AND change_type='pull_request.inspected'
      ORDER BY seq DESC LIMIT 1`,
    [task.id, executionId],
  );
  const payload = jsonObject(inspectionResult.rows[0]?.payload);
  const receipt = jsonObject(payload?.receipt);
  const inspected = jsonObject(payload?.snapshot);
  if (!payload || !receipt || !inspected
    || receipt.executionId !== executionId
    || receipt.taskId !== task.id
    || receipt.purpose !== purpose
    || receipt.providerPullRequestId !== providerPullRequestId
    || receipt.headOid !== headOid
    || payload.gateStatus !== 'success'
    || row?.provider_ci_inspection_id !== receipt.inspectionId
    || row?.provider_ci_execution_id !== executionId
    || row?.provider_ci_purpose !== purpose
    || row?.provider_ci_head_oid !== headOid
    || row?.provider_ci_status !== 'success') {
    throw new TaskboardValidationError(
      'Current execution must inspect the registered pull request and successful checks for the current head',
      'TASKBOARD_CI_INSPECTION_REQUIRED',
    );
  }
  const repository = jsonObject(board.repository);
  const provider = options.repositoryProvider;
  if (!repository || repository.provider !== 'github' || !provider) {
    throw new TaskboardValidationError('Repository provider is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  }
  let current: RepositoryPullRequestSnapshot;
  try {
    current = await provider.getPullRequest(
      repository as {
        provider: 'github'; repositoryId: string; owner: string; name: string;
        baseBranch: string; allowForkPullRequest: false;
      },
      providerPullRequestId,
      String(board.owner_user_id),
    );
  } catch (error) {
    throw new TaskboardValidationError(
      `Repository provider inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      'TASKBOARD_CI_UNAVAILABLE',
    );
  }
  assertPullRequestGate(current, {
    providerPullRequestId,
    headOid,
    ...(row?.base_oid ? { baseOid: String(row.base_oid) } : {}),
    ...(purpose === 'review' && row?.reviewed_subject_digest
      ? { subjectDigest: String(row.reviewed_subject_digest) }
      : {}),
  });
  return current;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
