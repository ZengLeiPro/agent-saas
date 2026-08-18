import pg from 'pg';

import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { parseStagePrompts } from './boardFields.js';
import { rowToExecution } from './storeHelpers.js';
import { normalizePage, pageResult } from './storeSearch.js';
import {
  TaskboardNotFoundError,
  type TaskboardExecutionContext,
  type TaskboardIdentity,
  type TaskboardPage,
  type TaskboardPageFilter,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface TaskboardExecutionSearchStore {
  pool: PgPool;
  boardsTable: string;
  tasksTable: string;
  executionsTable: string;
  resolutionsTable: string;
  changesTable: string;
}

function resolutionProjection(store: TaskboardExecutionSearchStore): string {
  return `r.outcome AS resolution_outcome,r.summary AS resolution_summary,
          r.to_status AS task_status_after,r.ignored_reason,r.historical AS resolution_historical,
          (r.execution_id IS NOT NULL) AS has_resolution,
          legacy.candidate_count AS legacy_resolution_count,
          legacy.valid_count AS legacy_resolution_valid_count`;
}

function resolutionJoins(store: TaskboardExecutionSearchStore): string {
  return `LEFT JOIN ${store.resolutionsTable} r ON r.execution_id=e.id
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS candidate_count,
                   count(*) FILTER (WHERE NULLIF(c.payload->>'outcome','') IS NOT NULL
                     AND NULLIF(c.payload->>'summary','') IS NOT NULL)::int AS valid_count
              FROM ${store.changesTable} c
             WHERE c.task_id=e.task_id AND c.change_type IN ('execution.resolved','execution.resolved.v2')
               AND (c.payload->>'executionId'=e.id
                 OR ((c.payload->>'executionId') IS NULL AND c.payload->>'runId'=e.run_id))
          ) legacy ON true`;
}

export async function listExecutions(
  store: TaskboardExecutionSearchStore,
  identity: TaskboardIdentity,
  taskId: string,
): Promise<TaskBoardExecution[]> {
  await assertTaskVisible(store, identity, taskId);
  const result = await store.pool.query(
    `SELECT e.*,${resolutionProjection(store)}
       FROM ${store.executionsTable} e
       ${resolutionJoins(store)}
       JOIN ${store.tasksTable} t ON t.id=e.task_id
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE e.task_id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 50`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  return result.rows.map(rowToExecution);
}

export async function searchExecutions(
  store: TaskboardExecutionSearchStore,
  identity: TaskboardIdentity,
  taskId: string,
  filter: TaskboardPageFilter = {},
): Promise<TaskboardPage<TaskBoardExecution>> {
  await assertTaskVisible(store, identity, taskId);
  const { page, pageSize, offset } = normalizePage(filter.page, filter.pageSize);
  const params = [taskId, identity.tenantId, identity.ownerUserId];
  const count = await store.pool.query(
    `SELECT count(*)::int AS total
       FROM ${store.executionsTable} e
       JOIN ${store.tasksTable} t ON t.id=e.task_id
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE e.task_id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    params,
  );
  const result = await store.pool.query(
    `SELECT e.*,${resolutionProjection(store)}
       FROM ${store.executionsTable} e
       ${resolutionJoins(store)}
       JOIN ${store.tasksTable} t ON t.id=e.task_id
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE e.task_id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $4 OFFSET $5`,
    [...params, pageSize, offset],
  );
  return pageResult(result.rows.map(rowToExecution), page, pageSize, Number(count.rows[0]?.total ?? 0));
}

interface TaskboardExecutionContextStore extends TaskboardExecutionSearchStore {
  getTask(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardTask>;
  listComments(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardComment[]>;
}

export async function getExecutionContextByRunId(
  store: TaskboardExecutionContextStore,
  runId: string,
): Promise<TaskboardExecutionContext | null> {
  return getExecutionContext(store, 'run_id', runId);
}

export async function getExecutionContextBySessionId(
  store: TaskboardExecutionContextStore,
  sessionId: string,
): Promise<TaskboardExecutionContext | null> {
  return getExecutionContext(store, 'session_id', sessionId);
}

async function getExecutionContext(
  store: TaskboardExecutionContextStore,
  column: 'run_id' | 'session_id',
  value: string,
): Promise<TaskboardExecutionContext | null> {
  const result = await store.pool.query(
    `SELECT e.*,${resolutionProjection(store)},
            b.tenant_id,b.owner_user_id,b.prompt AS board_prompt,b.stage_prompts AS board_stage_prompts
       FROM ${store.executionsTable} e
       ${resolutionJoins(store)}
       JOIN ${store.tasksTable} t ON t.id=e.task_id
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE e.${column}=$1
      ORDER BY CASE WHEN e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval') THEN 0 ELSE 1 END,
               e.created_at DESC, e.id DESC
      LIMIT 1`,
    [value],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  const identity: TaskboardIdentity = {
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    username: '',
  };
  const execution = rowToExecution(row);
  const stagePrompts = parseStagePrompts(row.board_stage_prompts);
  return {
    identity,
    task: await store.getTask(identity, execution.taskId),
    boardPrompt: String(row.board_prompt ?? ''),
    ...(Object.keys(stagePrompts).length ? { stagePrompts } : {}),
    comments: await store.listComments(identity, execution.taskId),
    execution,
  };
}

async function assertTaskVisible(
  store: TaskboardExecutionSearchStore,
  identity: TaskboardIdentity,
  taskId: string,
): Promise<void> {
  const access = await store.pool.query(
    `SELECT 1
       FROM ${store.tasksTable} t
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  if (!access.rows[0]) throw new TaskboardNotFoundError('Task not found');
}
