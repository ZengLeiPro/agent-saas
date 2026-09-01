import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardExecution,
  TaskBoardExecutionFinishInput,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { reconcileExecutionPullRequestMerge } from '../deliveryPullRequests.js';
import { integrationAgentTableNames } from '../integrationAgentSchema.js';
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
import { fenceTaskExecutions, loadWorkflowFacts } from './commandService.js';
import { EXECUTION_TRANSITIONED_REASON } from './cancellationOutbox.js';
import { assertIntegrationExecutionMigrated, decideTransition } from './decider.js';

const ACTIVE = ['queued', 'running', 'waiting_user', 'waiting_approval'];

export async function finishExecutionV2(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  runId: string,
  input: TaskBoardExecutionFinishInput,
): Promise<TaskBoardTask> {
  if (input.targetStatus === 'ready_to_merge') {
    const reconciled = await reconcileExecutionPullRequestMerge(options, identity, runId);
    if (reconciled) return reconciled;
  }
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
      `SELECT e.* FROM ${options.executionsTable} e WHERE e.run_id=$1 FOR UPDATE`, [runId]);
    const executionRow = executionResult.rows[0] as Record<string, unknown> | undefined;
    if (!executionRow) throw new TaskboardNotFoundError('Taskboard execution not found');
    const execution = rowToExecution(executionRow);
    if (executionRow.transitioned_at && loaded.task.kind === 'integration' && loaded.task.workflowVersion === 3
      && execution.purpose === 'work' && input.targetStatus === loaded.task.status
      && (input.targetStatus === 'done' || input.targetStatus === 'blocked')) {
      const prior = await client.query(
        `SELECT id FROM ${options.commentsTable}
          WHERE task_id=$1 AND author_type='agent' AND author_id=$2 AND body=$3
          ORDER BY created_at DESC LIMIT 1`, [taskId, execution.runId, input.body.trim()]);
      if (prior.rows[0]) return loadTask(options, client, taskId);
    }
    assertActiveExecution(executionRow, execution);
    assertIntegrationExecutionMigrated(loaded.task);
    await recordExecutionFinishComment(options, client, execution, input.body);

    if (loaded.task.kind === 'integration') {
      return transitionIntegrationAgent(options, client, identity, loaded.task, execution, input.targetStatus);
    }
    const facts = await loadWorkflowFacts(options, client, loaded.task);
    if (loaded.task.status === 'done' || loaded.task.status === 'canceled' || facts.hasMergeFact) {
      throw new TaskboardValidationError('Expired or terminal execution cannot transition the task', 'TASKBOARD_EXECUTION_FENCED');
    }
    const decision = decideTransition(loaded.task, execution.purpose, input.targetStatus, facts);
    const nextStatus = decision.toStatus;
    if (!nextStatus) throw new TaskboardValidationError('Transition does not advance task state', 'TASKBOARD_WORKFLOW_TRANSITION_INVALID');

    if (execution.purpose === 'work' && loaded.task.kind !== 'advisory'
      && nextStatus === 'in_review' && !loaded.task.providerPullRequestId) {
      throw new TaskboardValidationError('Delivery work must attach its pull request before review', 'TASKBOARD_PULL_REQUEST_REQUIRED');
    }
    await updateTaskStatus(options, client, taskId, nextStatus);
    if (nextStatus === 'blocked') await recordBlock(options, client, taskId, execution);
    await markTransitioned(options, client, execution, input.targetStatus);
    await appendChange(options, client, taskId, 'execution.transitioned', 'agent', identity.ownerUserId, {
      executionId: execution.id, runId, purpose: execution.purpose, fromStatus: loaded.task.status, status: nextStatus,
    });
    if (execution.purpose === 'review' && nextStatus === 'ready_to_merge' && loaded.task.kind === 'delivery') {
      await enqueueOnReadyTrigger(options, client, loaded.board, taskId);
    }
    return loadTask(options, client, taskId);
  });
}

async function transitionIntegrationAgent(
  options: TaskboardV2StoreOptions, client: PoolClient, identity: TaskboardIdentity,
  task: TaskBoardTask, execution: TaskBoardExecution, status: TaskBoardTask['status'],
): Promise<TaskBoardTask> {
  if (execution.purpose !== 'work' || (status !== 'done' && status !== 'blocked')) {
    throw new TaskboardValidationError(
      'Integration Agent can only finish the whole integration or request human help',
      'TASKBOARD_INTEGRATION_AGENT_TRANSITION_INVALID',
    );
  }
  const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
  await client.query(
    `UPDATE ${agentsTable}
        SET status=$2,review_head_oid=NULL,verdict=NULL,review_execution_id=NULL,
            merge_in_flight_execution_id=NULL,merge_in_flight_review_execution_id=NULL,
            merge_in_flight_review_head_oid=NULL,updated_at=now()
      WHERE integration_task_id=$1`,
    [task.id, status === 'done' ? 'merged' : 'active'],
  );
  if (status === 'done') {
    const sourceTasks = await client.query(
      `SELECT delivery.id
         FROM ${options.tasksTable} delivery
         JOIN ${options.integrationSourcesTable} source ON source.delivery_task_id=delivery.id
        WHERE source.integration_task_id=$1 AND source.state<>'canceled'
        ORDER BY delivery.id
        FOR UPDATE OF delivery`,
      [task.id],
    );
    await fenceTaskExecutions(
      options,
      client,
      sourceTasks.rows.map((row) => String(row.id)),
      'integration_completed',
    );
    await client.query(
      `UPDATE ${options.integrationSourcesTable}
          SET state='merged',last_error=NULL,updated_at=now()
        WHERE integration_task_id=$1 AND state<>'canceled'`,
      [task.id],
    );
    await client.query(
      `UPDATE ${options.tasksTable} delivery
          SET status='done',completed_at=COALESCE(completed_at,now()),version=version+1,updated_at=now()
        FROM ${options.integrationSourcesTable} source
       WHERE source.integration_task_id=$1 AND source.delivery_task_id=delivery.id
         AND delivery.status NOT IN ('done','canceled')`,
      [task.id],
    );
    await client.query(
      `UPDATE ${options.mergeAuthorizationsTable}
          SET revoked_at=COALESCE(revoked_at,now())
        WHERE integration_task_id=$1 AND revoked_at IS NULL`,
      [task.id],
    );
    await client.query(
      `UPDATE ${options.integrationLanesTable}
          SET active_integration_task_id=NULL,lease_id=NULL,epoch=epoch+1,updated_at=now()
        WHERE active_integration_task_id=$1`,
      [task.id],
    );
  }
  await client.query(
    `UPDATE ${options.tasksTable}
        SET status=$2,completed_at=CASE WHEN $2='done' THEN COALESCE(completed_at,now()) ELSE NULL END,
            workflow_epoch=workflow_epoch+1,next_action='none',next_action_revision=next_action_revision+1,
            version=version+1,updated_at=now()
      WHERE id=$1`,
    [task.id, status],
  );
  if (status === 'blocked') await recordBlock(options, client, task.id, execution);
  await markTransitioned(options, client, execution, status);
  await appendChange(options, client, task.id, 'integration.agent.finished', 'agent', identity.ownerUserId, {
    executionId: execution.id, runId: execution.runId, status,
  });
  return loadTask(options, client, task.id);
}

function assertActiveExecution(row: Record<string, unknown>, execution: TaskBoardExecution): void {
  if (!ACTIVE.includes(String(row.status)) || row.transitioned_at || execution.supersededAt) {
    throw new TaskboardValidationError('Taskboard execution is no longer active', 'TASKBOARD_EXECUTION_FENCED');
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
    throw new TaskboardValidationError('Execution finish comment is required', 'TASKBOARD_EXECUTION_COMMENT_REQUIRED');
  }
  const result = await client.query(
    `INSERT INTO ${options.commentsTable}
       (id,task_id,body,author_type,author_id,author_name,continuation_eligible,version)
     VALUES ($1,$2,$3,'agent',$4,'Agent',false,1)
     RETURNING id`,
    [randomUUID(), execution.taskId, normalized, execution.runId],
  );
  await appendChange(options, client, execution.taskId, 'execution.comment', 'agent', execution.runId, {
    commentId: String(result.rows[0]!.id),
  });
}

async function markTransitioned(options: TaskboardV2StoreOptions, client: PoolClient, execution: TaskBoardExecution, status: string): Promise<void> {
  const updated = await client.query(
    `UPDATE ${options.executionsTable} SET transitioned_at=now(),fence_epoch=fence_epoch+1,
       terminal_reason_code=$2,updated_at=now()
     WHERE id=$1 AND transitioned_at IS NULL
     RETURNING id,run_id,task_id,fence_epoch`,
    [execution.id, EXECUTION_TRANSITIONED_REASON],
  );
  const row = updated.rows[0];
  if (!row) throw new TaskboardValidationError(`Execution already transitioned to ${status}`, 'TASKBOARD_EXECUTION_FENCED');
  await client.query(
    `INSERT INTO ${options.cancellationOutboxTable}
       (id,execution_id,run_id,task_id,reason,fence_epoch)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (execution_id) DO NOTHING`,
    [randomUUID(), row.id, row.run_id, row.task_id, EXECUTION_TRANSITIONED_REASON, row.fence_epoch],
  );
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
