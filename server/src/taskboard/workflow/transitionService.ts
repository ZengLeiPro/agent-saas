import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardExecution,
  TaskBoardExecutionFinishInput,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import {
  createIntegrationAdmissionReceipt,
  loadIntegrationAdmissionContext,
} from '../integrationAdmission.js';
import { integrationAgentTableNames } from '../integrationAgentSchema.js';
import { repositoryWithBoardCiPolicy } from '../ciPolicy.js';
import { rowToExecution } from '../storeHelpers.js';
import {
  appendChange,
  enqueueOnReadyTrigger,
  loadAccessibleTaskAndBoard,
  loadTask,
  type TaskboardV2StoreOptions,
  withTransaction,
} from '../v2Store.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from '../types.js';
import { loadWorkflowFacts } from './commandService.js';
import {
  assertCurrentIntegrationAgentPullRequestGate,
  assertCurrentPullRequestGate,
} from './pullRequestGate.js';
import { assertIntegrationExecutionMigrated, decideTransition } from './decider.js';

const ACTIVE = ['queued', 'running', 'waiting_user', 'waiting_approval'];

export async function finishExecutionV2(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  runId: string,
  input: TaskBoardExecutionFinishInput,
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
    const executionResult = await client.query(
      `SELECT e.* FROM ${options.executionsTable} e WHERE e.run_id=$1 FOR UPDATE`,
      [runId],
    );
    const executionRow = executionResult.rows[0] as Record<string, unknown> | undefined;
    if (!executionRow) throw new TaskboardNotFoundError('Taskboard execution not found');
    const execution = rowToExecution(executionRow);
    if (
      executionRow.transitioned_at &&
      loaded.task.kind === 'integration' &&
      loaded.task.workflowVersion === 3 &&
      execution.purpose === 'merge' &&
      input.targetStatus === 'done' &&
      loaded.task.status === 'done'
    ) {
      const prior = await client.query(
        `SELECT id FROM ${options.commentsTable}
          WHERE task_id=$1 AND author_type='agent' AND author_id=$2 AND body=$3
          ORDER BY created_at DESC LIMIT 1`,
        [taskId, execution.runId, input.body.trim()],
      );
      if (prior.rows[0]) return loadTask(options, client, taskId);
    }
    assertActiveExecution(executionRow, execution);
    assertIntegrationExecutionMigrated(loaded.task);
    await recordExecutionFinishComment(options, client, execution, input.body);

    if (loaded.task.kind === 'integration') {
      return transitionIntegrationAgent(
        options,
        client,
        identity,
        loaded.task,
        execution,
        input.targetStatus,
      );
    }
    const facts = await loadWorkflowFacts(options, client, loaded.task);
    if (loaded.task.status === 'done' || loaded.task.status === 'canceled' || facts.hasMergeFact) {
      throw new TaskboardValidationError(
        'Expired or terminal execution cannot transition the task',
        'TASKBOARD_EXECUTION_FENCED',
      );
    }
    const decision = decideTransition(loaded.task, execution.purpose, input.targetStatus, facts);
    const nextStatus = decision.toStatus;
    if (!nextStatus)
      throw new TaskboardValidationError(
        'Transition does not advance task state',
        'TASKBOARD_WORKFLOW_TRANSITION_INVALID',
      );

    if (
      execution.purpose === 'work' &&
      loaded.task.kind !== 'advisory' &&
      nextStatus === 'in_review' &&
      !loaded.task.providerPullRequestId
    ) {
      throw new TaskboardValidationError(
        'Delivery work must attach its pull request before review',
        'TASKBOARD_PULL_REQUEST_REQUIRED',
      );
    }
    if (
      execution.purpose === 'review' &&
      nextStatus === 'ready_to_merge' &&
      !loaded.task.reviewedSubjectDigest
    ) {
      throw new TaskboardValidationError(
        'Review must record the exact pull request subject before approval',
        'TASKBOARD_REVIEW_SUBJECT_REQUIRED',
      );
    }
    if (
      (execution.purpose === 'work' && nextStatus === 'in_review') ||
      (execution.purpose === 'review' && nextStatus === 'ready_to_merge')
    ) {
      await assertCurrentPullRequestGate(
        options,
        client,
        loaded.task,
        loaded.board,
        execution.id,
        execution.purpose,
      );
    }
    await updateTaskStatus(options, client, taskId, nextStatus);
    if (nextStatus === 'blocked') await recordBlock(options, client, taskId, execution);
    await markTransitioned(options, client, execution, input.targetStatus);
    await appendChange(
      options,
      client,
      taskId,
      'execution.transitioned',
      'agent',
      identity.ownerUserId,
      {
        executionId: execution.id,
        runId,
        purpose: execution.purpose,
        fromStatus: loaded.task.status,
        status: nextStatus,
      },
    );
    if (
      execution.purpose === 'review' &&
      nextStatus === 'ready_to_merge' &&
      loaded.task.kind === 'delivery'
    ) {
      await enqueueOnReadyTrigger(options, client, loaded.board, taskId);
    }
    return loadTask(options, client, taskId);
  });
}

async function transitionIntegrationAgent(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  identity: TaskboardIdentity,
  task: TaskBoardTask,
  execution: TaskBoardExecution,
  status: TaskBoardTask['status'],
): Promise<TaskBoardTask> {
  const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
  if (execution.purpose === 'merge' && status === 'done' && task.status === 'done') {
    const terminal = await client.query(
      `SELECT status,cleanup_receipt FROM ${agentsTable} WHERE integration_task_id=$1 FOR UPDATE`,
      [task.id],
    );
    const cleanup = jsonObject(terminal.rows[0]?.cleanup_receipt);
    if (terminal.rows[0]?.status !== 'merged' || cleanup?.completed !== true) {
      throw new TaskboardValidationError(
        'Integration Agent cleanup is incomplete',
        'TASKBOARD_INTEGRATION_INCOMPLETE',
      );
    }
    await markTransitioned(options, client, execution, status);
    await appendChange(
      options,
      client,
      task.id,
      'integration.agent.transitioned',
      'agent',
      identity.ownerUserId,
      {
        executionId: execution.id,
        runId: execution.runId,
        purpose: execution.purpose,
        status: 'done',
      },
    );
    return loadTask(options, client, task.id);
  }
  let nextStatus: TaskBoardTask['status'];
  let agentStatus: 'active' | 'reviewing' | 'ready_to_merge';
  if (execution.purpose === 'work' && status === 'in_review') {
    nextStatus = 'in_review';
    agentStatus = 'reviewing';
  } else if (execution.purpose === 'review' && status === 'ready_to_merge') {
    const gate = await assertCurrentIntegrationAgentPullRequestGate(
      options,
      client,
      task,
      execution.id,
    );
    const admission = await loadIntegrationAdmissionContext(options, client, task.id);
    if (!options.repositoryProvider?.getCommit) {
      throw new TaskboardValidationError(
        'Repository provider cannot bind the approved candidate tree',
        'TASKBOARD_CI_UNAVAILABLE',
      );
    }
    const configuredRepository = repositoryWithBoardCiPolicy(
      admission.repository,
      admission.policy,
    );
    const headCommit = await options.repositoryProvider.getCommit(
      configuredRepository,
      gate.headOid,
      admission.credentialOwnerId,
    );
    if (
      headCommit.oid !== gate.headOid ||
      !headCommit.treeOid ||
      !gate.baseOid ||
      !gate.subjectDigest
    ) {
      throw new TaskboardValidationError(
        'Provider could not bind the approved integration revision',
        'TASKBOARD_SUBJECT_STALE',
      );
    }
    const receipt = createIntegrationAdmissionReceipt({
      candidateId: task.id,
      candidateRevision: admission.candidateRevision + 1,
      reviewExecutionId: execution.id,
      headOid: gate.headOid,
      baseOid: gate.baseOid,
      treeOid: headCommit.treeOid,
      subjectDigest: gate.subjectDigest,
      workflowEpoch: admission.workflowEpoch + 1,
      laneEpoch: admission.laneEpoch,
      policyRevision: admission.policyRevision,
      policyDigest: admission.policyDigest,
      sourceSetDigest: admission.sourceSetDigest,
    });
    await client.query(
      `UPDATE ${agentsTable}
          SET review_head_oid=$2,admission_receipt=$3::jsonb
        WHERE integration_task_id=$1`,
      [task.id, gate.headOid, JSON.stringify(receipt)],
    );
    nextStatus = 'ready_to_merge';
    agentStatus = 'ready_to_merge';
  } else if (execution.purpose === 'review' && (status === 'todo' || status === 'in_review')) {
    nextStatus = status === 'todo' ? 'in_progress' : 'in_review';
    agentStatus = status === 'todo' ? 'active' : 'reviewing';
  } else {
    throw new TaskboardValidationError(
      'Integration Agent can only request review, return for repair, or record approval',
      'TASKBOARD_INTEGRATION_AGENT_TRANSITION_INVALID',
    );
  }
  await client.query(
    `UPDATE ${agentsTable}
      SET status=$2, verdict=CASE WHEN $2='ready_to_merge' THEN 'approved' ELSE NULL END,
          review_execution_id=CASE WHEN $2='ready_to_merge' THEN $3 ELSE NULL END,
          admission_receipt=CASE WHEN $2='ready_to_merge' THEN admission_receipt ELSE NULL END,
          updated_at=now()
      WHERE integration_task_id=$1`,
    [task.id, agentStatus, execution.id],
  );
  await updateTaskStatus(options, client, task.id, nextStatus);
  await markTransitioned(options, client, execution, status);
  await appendChange(
    options,
    client,
    task.id,
    'integration.agent.transitioned',
    'agent',
    identity.ownerUserId,
    {
      executionId: execution.id,
      runId: execution.runId,
      purpose: execution.purpose,
      status: nextStatus,
    },
  );
  return loadTask(options, client, task.id);
}

function assertActiveExecution(row: Record<string, unknown>, execution: TaskBoardExecution): void {
  if (!ACTIVE.includes(String(row.status)) || row.transitioned_at || execution.supersededAt) {
    throw new TaskboardValidationError(
      'Taskboard execution is no longer active',
      'TASKBOARD_EXECUTION_FENCED',
    );
  }
}

async function recordExecutionFinishComment(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  execution: TaskBoardExecution,
  body: string,
): Promise<void> {
  const normalized = body.trim();
  if (!normalized) {
    throw new TaskboardValidationError(
      'Execution finish comment is required',
      'TASKBOARD_EXECUTION_COMMENT_REQUIRED',
    );
  }
  const result = await client.query(
    `INSERT INTO ${options.commentsTable}
       (id,task_id,body,author_type,author_id,author_name,continuation_eligible,version)
     VALUES ($1,$2,$3,'agent',$4,'Agent',false,1)
     RETURNING id`,
    [randomUUID(), execution.taskId, normalized, execution.runId],
  );
  await appendChange(
    options,
    client,
    execution.taskId,
    'execution.comment',
    'agent',
    execution.runId,
    {
      commentId: String(result.rows[0]!.id),
    },
  );
}

async function markTransitioned(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  execution: TaskBoardExecution,
  status: string,
): Promise<void> {
  const updated = await client.query(
    `UPDATE ${options.executionsTable} SET transitioned_at=now(),fence_epoch=fence_epoch+1,
       terminal_reason_code='execution_transitioned',updated_at=now()
     WHERE id=$1 AND transitioned_at IS NULL RETURNING id`,
    [execution.id],
  );
  if (!updated.rows[0])
    throw new TaskboardValidationError(
      `Execution already transitioned to ${status}`,
      'TASKBOARD_EXECUTION_FENCED',
    );
}

async function updateTaskStatus(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  taskId: string,
  status: string,
): Promise<void> {
  await client.query(
    `UPDATE ${options.tasksTable} SET status=$2,completed_at=CASE WHEN $2='done' THEN now() ELSE NULL END,
       workflow_epoch=workflow_epoch+1,next_action=CASE WHEN $2='todo' THEN 'work' WHEN $2='in_review' THEN 'review'
       WHEN $2='ready_to_merge' THEN 'merge' ELSE 'none' END,next_action_revision=next_action_revision+1,
       version=version+1,updated_at=now() WHERE id=$1`,
    [taskId, status],
  );
}

async function recordBlock(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  taskId: string,
  execution: TaskBoardExecution,
): Promise<void> {
  await client.query(
    `INSERT INTO ${options.blockEpisodesTable}(id,task_id,purpose,execution_id,reason_code,reason)
     VALUES ($1,$2,$3,$4,'agent_needs_human','See the execution Agent comment')`,
    [randomUUID(), taskId, execution.purpose, execution.id],
  );
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
