import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { TaskBoard, TaskBoardTask, TaskBoardTaskCreateInput } from '../../../shared/src/types/taskboard.js';
import { normalizeModel, stageModelsToJson } from './boardFields.js';
import {
  claimExistingTaskCreation,
  completeTaskCreationClaim,
  newTaskCreationClaim,
  releaseTaskCreationClaim,
  waitForTaskCreationClaim,
} from './taskCreationLifecycle.js';
import { assertActiveBoard, assertBoardRole, assertTaskContent, normalizeAttachments, normalizeLabels, optionalText } from './storeHelpers.js';
import { TaskboardValidationError, type TaskboardIdentity, type TaskboardTaskCreateResult } from './types.js';

interface TaskCreateStore {
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  changesTable: string;
  withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
  requireBoard(client: PoolClient, identity: TaskboardIdentity, boardId: string, forUpdate: boolean): Promise<TaskBoard>;
  requireTask(client: PoolClient, identity: TaskboardIdentity, taskId: string, forUpdate: boolean): Promise<TaskBoardTask>;
}

export async function createStoredTask(
  store: TaskCreateStore,
  identity: TaskboardIdentity,
  boardId: string,
  input: TaskBoardTaskCreateInput,
): Promise<TaskBoardTask> {
  const retry = () => createStoredTaskWithResult(store, identity, boardId, input);
  const result = await waitForTaskCreationClaim(await retry(), retry);
  return result.creationClaimToken
    ? completeStoredTaskCreation(store, identity, result.task.id, result.creationClaimToken)
    : result.task;
}

export async function createStoredTaskWithResult(
  store: TaskCreateStore,
  identity: TaskboardIdentity,
  boardId: string,
  input: TaskBoardTaskCreateInput,
): Promise<TaskboardTaskCreateResult> {
  return store.withTransaction(async (client) => {
    const board = await store.requireBoard(client, identity, boardId, true);
    assertBoardRole(board.role, 'editor');
    assertActiveBoard(board);
    validateTaskCreateInput(input);
    if (input.clientRequestId) {
      const existing = await claimExistingTaskCreation(client, store, boardId, input.clientRequestId);
      if (existing) return existing;
    }
    const numberResult = await client.query(
      `UPDATE ${store.boardsTable}
          SET next_task_number=next_task_number+1
        WHERE id=$1 AND tenant_id=$2 AND (owner_user_id=$3 OR visibility='organization')
        RETURNING next_task_number-1 AS task_number`,
      [boardId, identity.tenantId, identity.ownerUserId],
    );
    const status = input.status ?? 'backlog';
    const tailResult = await client.query(
      `SELECT COALESCE(MAX(t.sort_order), 0) AS max_sort_order
         FROM ${store.tasksTable} t JOIN ${store.boardsTable} b ON b.id=t.board_id
        WHERE t.board_id=$1 AND t.status=$2 AND t.archived_at IS NULL
          AND b.tenant_id=$3 AND (b.owner_user_id=$4 OR b.visibility='organization')`,
      [boardId, status, identity.tenantId, identity.ownerUserId],
    );
    const taskId = randomUUID();
    const creation = newTaskCreationClaim(input.clientRequestId);
    await client.query(
      `INSERT INTO ${store.tasksTable}
         (id,board_id,identifier,kind,title,description,branch,attachments,status,priority,labels,sort_order,
          due_at,model,stage_models,provider_pull_request_id,pull_request_number,reviewed_subject_digest,
          creator_user_id,creator_name,completed_at,client_request_id,creation_state,creation_lease_id,
          creation_lease_expires_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,
               CASE WHEN $9='done' THEN now() END,$21,$22,$23,
               CASE WHEN $22='pending' THEN now()+interval '5 minutes' END,1)`,
      [
        taskId, boardId, `TASK-${Number(numberResult.rows[0]?.task_number)}`, input.kind ?? 'delivery',
        input.title ?? '', input.description ?? '', optionalText(input.branch),
        JSON.stringify(normalizeAttachments(input.attachments)), status, input.priority ?? 'none',
        normalizeLabels(input.labels), Number(tailResult.rows[0]?.max_sort_order ?? 0) + 1024,
        input.dueAt ?? null, normalizeModel(input.stageModels !== undefined ? undefined : input.model),
        stageModelsToJson(input.stageModels), optionalText(input.providerPullRequestId),
        input.pullRequestNumber ?? null, optionalText(input.reviewedSubjectDigest), identity.ownerUserId,
        identity.displayName?.trim() || identity.username, optionalText(input.clientRequestId), creation.state,
        creation.token,
      ],
    );
    await client.query(
      `INSERT INTO ${store.changesTable}
         (task_id,change_type,actor_type,actor_id,payload)
       VALUES ($1,'task.created','user',$2,$3::jsonb)`,
      [taskId, identity.ownerUserId, JSON.stringify({ kind: input.kind ?? 'delivery', status })],
    );
    return {
      task: await store.requireTask(client, identity, taskId, false), created: true,
      ...(creation.token ? { creationClaimToken: creation.token } : {}),
    };
  });
}

export async function completeStoredTaskCreation(
  store: TaskCreateStore,
  identity: TaskboardIdentity,
  taskId: string,
  claimToken: string,
): Promise<TaskBoardTask> {
  return store.withTransaction(async (client) => {
    await store.requireTask(client, identity, taskId, false);
    const completed = await completeTaskCreationClaim(client, store.tasksTable, taskId, claimToken);
    if (!completed) {
      const state = await client.query(`SELECT creation_state FROM ${store.tasksTable} WHERE id=$1`, [taskId]);
      if (state.rows[0]?.creation_state !== 'complete') throw new TaskboardValidationError('Task creation claim is no longer owned');
    }
    return store.requireTask(client, identity, taskId, false);
  });
}

export async function releaseStoredTaskCreation(
  store: TaskCreateStore,
  identity: TaskboardIdentity,
  taskId: string,
  claimToken: string,
): Promise<void> {
  await store.withTransaction(async (client) => {
    await store.requireTask(client, identity, taskId, false);
    await releaseTaskCreationClaim(client, store.tasksTable, taskId, claimToken);
  });
}

function validateTaskCreateInput(input: TaskBoardTaskCreateInput): void {
  assertTaskContent(input.title, input.description);
  if (input.kind === 'integration' || input.kind === 'remediation') {
    throw new TaskboardValidationError(
      'Integration and remediation tasks must be created by their dedicated workflow',
      'TASKBOARD_INTERNAL_TASK_CREATE_REQUIRES_WORKFLOW',
    );
  }
  if (input.kind === 'advisory' && (
    input.branch || input.providerPullRequestId || input.pullRequestNumber || input.reviewedSubjectDigest
  )) {
    throw new TaskboardValidationError(
      'Advisory tasks cannot carry repository or pull request fields',
      'TASKBOARD_ADVISORY_REPOSITORY_FORBIDDEN',
    );
  }
  if (input.status && !['backlog', 'todo', 'in_progress'].includes(input.status)) {
    throw new TaskboardValidationError(
      'Initial task status is controlled by the taskboard workflow',
      'TASKBOARD_PROTECTED_TRANSITION',
    );
  }
}
