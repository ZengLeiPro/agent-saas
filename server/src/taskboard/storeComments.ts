import pg, { type PoolClient } from 'pg';

import type {
  TaskBoardComment,
  TaskBoardCommentPatchInput,
} from '../../../shared/src/types/taskboard.js';
import {
  applyCommentAuthorDisplayName,
  assertExpectedVersion,
  rowToComment,
} from './storeHelpers.js';
import {
  TaskboardNotFoundError,
  TaskboardPermissionError,
  TaskboardValidationError,
  type TaskboardExpectedVersionInput,
  type TaskboardIdentity,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface TaskboardCommentStore {
  pool: PgPool;
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  changesTable: string;
}

export async function updateComment(
  store: TaskboardCommentStore,
  identity: TaskboardIdentity,
  commentId: string,
  input: TaskBoardCommentPatchInput,
): Promise<TaskBoardComment> {
  return withTransaction(store.pool, async (client) => {
    const loaded = await requireCommentWithBoard(store, client, identity, commentId, true);
    assertCommentManageable(loaded, identity);
    assertExpectedVersion(loaded.comment, input.expectedVersion);
    const body = input.body.trim();
    if (!body && !loaded.comment.attachments?.length) {
      throw new TaskboardValidationError('Comment body or attachment is required');
    }
    const result = await client.query(
      `UPDATE ${store.commentsTable}
          SET body=$2, version=version+1, updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [commentId, body],
    );
    await appendCommentChange(store, client, loaded.taskId, 'comment.updated', identity.ownerUserId, commentId, false);
    return applyCommentAuthorDisplayName(rowToComment(result.rows[0]), identity);
  });
}

export async function deleteComment(
  store: TaskboardCommentStore,
  identity: TaskboardIdentity,
  commentId: string,
  input: TaskboardExpectedVersionInput,
): Promise<TaskBoardComment> {
  return withTransaction(store.pool, async (client) => {
    const loaded = await requireCommentWithBoard(store, client, identity, commentId, true);
    assertCommentManageable(loaded, identity);
    assertExpectedVersion(loaded.comment, input.expectedVersion);
    await client.query(`DELETE FROM ${store.commentsTable} WHERE id=$1`, [commentId]);
    await appendCommentChange(store, client, loaded.taskId, 'comment.deleted', identity.ownerUserId, commentId, true);
    return applyCommentAuthorDisplayName(loaded.comment, identity);
  });
}

interface CommentWithBoard {
  comment: TaskBoardComment;
  taskId: string;
  boardOwnerUserId: string;
  taskArchived: boolean;
  boardArchived: boolean;
}

async function requireCommentWithBoard(
  store: TaskboardCommentStore,
  db: PoolClient,
  identity: TaskboardIdentity,
  commentId: string,
  forUpdate: boolean,
): Promise<CommentWithBoard> {
  const ownership = await db.query(
    `SELECT t.board_id, t.id AS task_id
       FROM ${store.commentsTable} c
       JOIN ${store.tasksTable} t ON t.id=c.task_id
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE c.id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    [commentId, identity.tenantId, identity.ownerUserId],
  );
  if (!ownership.rows[0]) throw new TaskboardNotFoundError('Comment not found');
  const board = await db.query(
    `SELECT owner_user_id, archived_at
       FROM ${store.boardsTable}
      WHERE id=$1 AND tenant_id=$2
        AND (owner_user_id=$3 OR visibility='organization')
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [ownership.rows[0].board_id, identity.tenantId, identity.ownerUserId],
  );
  if (!board.rows[0]) throw new TaskboardNotFoundError('Comment not found');
  const task = await db.query(
    `SELECT archived_at FROM ${store.tasksTable}
      WHERE id=$1 AND board_id=$2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [ownership.rows[0].task_id, ownership.rows[0].board_id],
  );
  if (!task.rows[0]) throw new TaskboardNotFoundError('Comment not found');
  const result = await db.query(
    `SELECT * FROM ${store.commentsTable}
      WHERE id=$1 AND task_id=$2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [commentId, ownership.rows[0].task_id],
  );
  if (!result.rows[0]) throw new TaskboardNotFoundError('Comment not found');
  return {
    comment: rowToComment(result.rows[0]),
    taskId: String(ownership.rows[0].task_id),
    boardOwnerUserId: String(board.rows[0].owner_user_id),
    taskArchived: Boolean(task.rows[0].archived_at),
    boardArchived: Boolean(board.rows[0].archived_at),
  };
}

function assertCommentManageable(loaded: CommentWithBoard, identity: TaskboardIdentity): void {
  if (loaded.taskArchived || loaded.boardArchived) {
    throw new TaskboardValidationError('Archived comments are read-only');
  }
  const isAuthor = loaded.comment.authorType === 'user'
    && loaded.comment.authorId === identity.ownerUserId;
  if (!isAuthor && loaded.boardOwnerUserId !== identity.ownerUserId) {
    throw new TaskboardPermissionError('Only the comment author or board owner may manage this comment');
  }
}

async function appendCommentChange(
  store: TaskboardCommentStore,
  client: PoolClient,
  taskId: string,
  changeType: string,
  actorId: string,
  commentId: string,
  tombstone: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO ${store.changesTable}
       (task_id, change_type, actor_type, actor_id, payload, tombstone)
     VALUES ($1,$2,'user',$3,$4::jsonb,$5)`,
    [taskId, changeType, actorId, JSON.stringify({ commentId }), tombstone],
  );
}

async function withTransaction<T>(pool: PgPool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
