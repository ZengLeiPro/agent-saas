import pg from 'pg';

import type { TaskBoardExecution } from '../../../shared/src/types/taskboard.js';
import { rowToExecution } from './storeHelpers.js';
import { normalizePage, pageResult } from './storeSearch.js';
import {
  TaskboardNotFoundError,
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
}

export async function listExecutions(
  store: TaskboardExecutionSearchStore,
  identity: TaskboardIdentity,
  taskId: string,
): Promise<TaskBoardExecution[]> {
  await assertTaskVisible(store, identity, taskId);
  const result = await store.pool.query(
    `SELECT e.*
       FROM ${store.executionsTable} e
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
    `SELECT e.*
       FROM ${store.executionsTable} e
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
