import type { PoolClient } from 'pg';

import type { TaskBoardStatus, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { rowToTask } from './storeHelpers.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from './types.js';

interface ExecutionTaskMoveOptions {
  pool: { connect(): Promise<PoolClient> };
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
}

const ACTIVE_EXECUTION_STATUSES = ['queued', 'running', 'waiting_user', 'waiting_approval'];
const SORT_GAP = 1024;

/**
 * 复核 Agent 的 done/todo 决策与 Execution 活跃态校验必须同事务完成。
 * 锁顺序与其他写操作保持一致：Board → Task → Execution，避免归档或终态竞态覆盖。
 */
export async function moveTaskFromReviewExecution(
  options: ExecutionTaskMoveOptions,
  identity: TaskboardIdentity,
  runId: string,
  status: Extract<TaskBoardStatus, 'done' | 'todo'>,
): Promise<TaskBoardTask> {
  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    const boardResult = await client.query(
      `SELECT b.id, b.archived_at
         FROM ${options.executionsTable} e
         JOIN ${options.tasksTable} t ON t.id=e.task_id
         JOIN ${options.boardsTable} b ON b.id=t.board_id
        WHERE e.run_id=$1 AND b.tenant_id=$2
          AND (b.owner_user_id=$3 OR b.visibility='organization')
        FOR UPDATE OF b`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    const boardRow = boardResult.rows[0];
    if (!boardRow) throw new TaskboardNotFoundError('Taskboard execution not found');
    const taskResult = await client.query(
      `SELECT t.id, t.board_id, t.status, t.archived_at AS task_archived_at
         FROM ${options.executionsTable} e
         JOIN ${options.tasksTable} t ON t.id=e.task_id
        WHERE e.run_id=$1 AND t.board_id=$2
        FOR UPDATE OF t`,
      [runId, boardRow.id],
    );
    const taskRow = taskResult.rows[0];
    if (!taskRow) throw new TaskboardNotFoundError('Taskboard execution not found');
    if (boardRow.archived_at || taskRow.task_archived_at) {
      throw new TaskboardValidationError('Archived taskboard resources are read-only');
    }
    if (String(taskRow.status) !== 'in_progress') {
      throw new TaskboardValidationError(
        'Task status changed while review was running',
        'TASKBOARD_REVIEW_TASK_CHANGED',
      );
    }

    const executionResult = await client.query(
      `SELECT status, purpose FROM ${options.executionsTable} WHERE run_id=$1 FOR UPDATE`,
      [runId],
    );
    const executionRow = executionResult.rows[0];
    if (
      !executionRow
      || executionRow.purpose !== 'review'
      || !ACTIVE_EXECUTION_STATUSES.includes(String(executionRow.status))
    ) {
      throw new TaskboardValidationError(
        'Review execution is no longer active',
        'TASKBOARD_REVIEW_EXECUTION_INACTIVE',
      );
    }

    const peers = await client.query(
      `SELECT t.sort_order
         FROM ${options.tasksTable} t
        WHERE t.board_id=$1 AND t.id<>$2 AND t.status=$3 AND t.archived_at IS NULL
        ORDER BY t.sort_order DESC, t.created_at DESC, t.id DESC
        FOR UPDATE OF t`,
      [taskRow.board_id, taskRow.id, status],
    );
    const lastSortOrder = peers.rows[0] ? Number(peers.rows[0].sort_order) : 0;
    const sortOrder = Number.isFinite(lastSortOrder) ? lastSortOrder + SORT_GAP : SORT_GAP;
    await client.query(
      `UPDATE ${options.tasksTable}
          SET status=$2, sort_order=$3, version=version+1, updated_at=now()
        WHERE id=$1`,
      [taskRow.id, status, sortOrder],
    );
    const updated = await client.query(
      `SELECT t.*,
              (SELECT count(*)::int FROM ${options.commentsTable} c WHERE c.task_id=t.id) AS comment_count
         FROM ${options.tasksTable} t
        WHERE t.id=$1`,
      [taskRow.id],
    );
    await client.query('COMMIT');
    return rowToTask(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
