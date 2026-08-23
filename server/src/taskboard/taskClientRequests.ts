import pg from 'pg';

import type { TaskBoard, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { assertActiveBoard, assertBoardRole, rowToTask, visibleCommentPredicate } from './storeHelpers.js';
import type { TaskboardIdentity } from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface TaskClientRequestStore {
  pool: PgPool;
  tasksTable: string;
  commentsTable: string;
  changesTable: string;
  getBoard(identity: TaskboardIdentity, boardId: string): Promise<TaskBoard>;
}

export async function findTaskByClientRequestId(
  store: TaskClientRequestStore,
  identity: TaskboardIdentity,
  boardId: string,
  clientRequestId: string,
): Promise<TaskBoardTask | null> {
  const board = await store.getBoard(identity, boardId);
  assertBoardRole(board.role, 'editor');
  assertActiveBoard(board);
  const result = await store.pool.query(
    `SELECT t.*, (SELECT count(*)::int FROM ${store.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', store.changesTable)}) AS comment_count
       FROM ${store.tasksTable} t
      WHERE t.board_id=$1 AND t.client_request_id=$2 AND t.deleted_at IS NULL`,
    [boardId, clientRequestId],
  );
  return result.rows[0] ? rowToTask(result.rows[0]) : null;
}
