import pg from 'pg';

import type { TaskBoard, TaskBoardComment, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { rowToBoard } from './boardFields.js';
import { applyCommentAuthorDisplayName, normalizeLabels, rowToComment, rowToTask } from './storeHelpers.js';
import { TaskboardNotFoundError } from './types.js';
import type {
  TaskboardBoardSearchFilter,
  TaskboardIdentity,
  TaskboardPage,
  TaskboardPageFilter,
  TaskboardTaskListFilter,
  TaskboardTaskSearchFilter,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface TaskboardSearchStore {
  pool: PgPool;
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  membersTable: string;
}

export async function listBoards(
  store: TaskboardSearchStore,
  identity: TaskboardIdentity,
  includeArchived = false,
): Promise<TaskBoard[]> {
  const result = await store.pool.query(
    `SELECT b.id, b.owner_user_id, b.name, b.description, b.visibility, b.prompt, b.stage_prompts, b.model,
            b.repository, b.integration_policy, b.version, b.archived_at, b.created_at, b.updated_at,
            CASE WHEN b.owner_user_id=$2 THEN 'owner' ELSE COALESCE(m.role,'viewer') END AS board_role
       FROM ${store.boardsTable} b
       LEFT JOIN ${store.membersTable} m ON m.board_id=b.id AND m.user_id=$2
      WHERE b.tenant_id=$1
        AND (b.owner_user_id=$2 OR b.visibility='organization')
        AND ($3::boolean OR b.archived_at IS NULL)
      ORDER BY b.archived_at NULLS FIRST, b.updated_at DESC, b.id`,
    [identity.tenantId, identity.ownerUserId, includeArchived],
  );
  return result.rows.map((row) => rowToBoard(row, identity.ownerUserId));
}

export async function listTasks(
  store: TaskboardSearchStore,
  identity: TaskboardIdentity,
  boardId: string,
  filter: TaskboardTaskListFilter = {},
): Promise<TaskBoardTask[]> {
  const conditions = [
    't.board_id=$1',
    'b.tenant_id=$2',
    "(b.owner_user_id=$3 OR b.visibility='organization')",
    '($4::boolean OR t.archived_at IS NULL)',
  ];
  const params: unknown[] = [boardId, identity.tenantId, identity.ownerUserId, filter.includeArchived === true];
  if (filter.statuses?.length) {
    params.push(filter.statuses);
    conditions.push(`t.status=ANY($${params.length}::text[])`);
  }
  if (filter.priorities?.length) {
    params.push(filter.priorities);
    conditions.push(`t.priority=ANY($${params.length}::text[])`);
  }
  const search = filter.search?.trim();
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(
      t.identifier ILIKE $${params.length}
      OR t.title ILIKE $${params.length}
      OR t.description ILIKE $${params.length}
      OR t.branch ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM unnest(t.labels) AS label WHERE label ILIKE $${params.length})
    )`);
  }
  const result = await store.pool.query(
    `SELECT t.*,
            (SELECT count(*)::int FROM ${store.commentsTable} c WHERE c.task_id=t.id) AS comment_count
       FROM ${store.tasksTable} t
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.archived_at NULLS FIRST, t.status, t.sort_order, t.created_at, t.id`,
    params,
  );
  return result.rows.map(rowToTask);
}

export async function searchBoards(
  store: TaskboardSearchStore,
  identity: TaskboardIdentity,
  filter: TaskboardBoardSearchFilter = {},
): Promise<TaskboardPage<TaskBoard>> {
  const { page, pageSize, offset } = normalizePage(filter.page, filter.pageSize);
  const conditions = [
    'b.tenant_id=$1',
    "(b.owner_user_id=$2 OR b.visibility='organization')",
    '($3::boolean OR b.archived_at IS NULL)',
  ];
  const params: unknown[] = [identity.tenantId, identity.ownerUserId, filter.includeArchived === true];
  const search = filter.search?.trim();
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(b.name ILIKE $${params.length} OR b.description ILIKE $${params.length})`);
  }
  const where = conditions.join(' AND ');
  const count = await store.pool.query(
    `SELECT count(*)::int AS total FROM ${store.boardsTable} b WHERE ${where}`,
    params,
  );
  params.push(pageSize, offset);
  const result = await store.pool.query(
    `SELECT b.id, b.owner_user_id, b.name, b.description, b.visibility, b.prompt, b.stage_prompts, b.model,
            b.repository, b.integration_policy, b.version, b.archived_at, b.created_at, b.updated_at,
            CASE WHEN b.owner_user_id=$2 THEN 'owner' ELSE COALESCE(m.role,'viewer') END AS board_role
       FROM ${store.boardsTable} b
       LEFT JOIN ${store.membersTable} m ON m.board_id=b.id AND m.user_id=$2
      WHERE ${where}
      ORDER BY b.archived_at NULLS FIRST, b.updated_at DESC, b.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = Number(count.rows[0]?.total ?? 0);
  return pageResult(result.rows.map((row) => rowToBoard(row, identity.ownerUserId)), page, pageSize, total);
}

export async function searchTasks(
  store: TaskboardSearchStore,
  identity: TaskboardIdentity,
  filter: TaskboardTaskSearchFilter = {},
): Promise<TaskboardPage<TaskBoardTask>> {
  const { page, pageSize, offset } = normalizePage(filter.page, filter.pageSize);
  const conditions = [
    'b.tenant_id=$1',
    "(b.owner_user_id=$2 OR b.visibility='organization')",
    '($3::boolean OR (t.archived_at IS NULL AND b.archived_at IS NULL))',
  ];
  const params: unknown[] = [identity.tenantId, identity.ownerUserId, filter.includeArchived === true];
  const add = (condition: (position: number) => string, value: unknown): void => {
    params.push(value);
    conditions.push(condition(params.length));
  };
  if (filter.boardId) add((position) => `t.board_id=$${position}`, filter.boardId);
  if (filter.boardName?.trim()) add((position) => `b.name ILIKE $${position}`, `%${filter.boardName.trim()}%`);
  if (filter.statuses?.length) add((position) => `t.status=ANY($${position}::text[])`, filter.statuses);
  if (filter.priorities?.length) add((position) => `t.priority=ANY($${position}::text[])`, filter.priorities);
  if (filter.labels?.length) add((position) => `t.labels @> $${position}::text[]`, normalizeLabels(filter.labels));
  if (filter.creatorUserId?.trim()) add((position) => `t.creator_user_id=$${position}`, filter.creatorUserId.trim());
  if (filter.createdAfter) add((position) => `t.created_at >= $${position}::timestamptz`, filter.createdAfter);
  if (filter.createdBefore) add((position) => `t.created_at <= $${position}::timestamptz`, filter.createdBefore);
  if (filter.updatedAfter) add((position) => `t.updated_at >= $${position}::timestamptz`, filter.updatedAfter);
  if (filter.updatedBefore) add((position) => `t.updated_at <= $${position}::timestamptz`, filter.updatedBefore);
  if (filter.dueAfter) add((position) => `t.due_at >= $${position}::timestamptz`, filter.dueAfter);
  if (filter.dueBefore) add((position) => `t.due_at <= $${position}::timestamptz`, filter.dueBefore);
  const search = filter.search?.trim();
  if (search) {
    add((position) => `(
      t.identifier ILIKE $${position}
      OR t.title ILIKE $${position}
      OR t.description ILIKE $${position}
      OR t.branch ILIKE $${position}
      OR EXISTS (SELECT 1 FROM unnest(t.labels) AS label WHERE label ILIKE $${position})
    )`, `%${search}%`);
  }
  const where = conditions.join(' AND ');
  const count = await store.pool.query(
    `SELECT count(*)::int AS total
       FROM ${store.tasksTable} t
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE ${where}`,
    params,
  );
  params.push(pageSize, offset);
  const result = await store.pool.query(
    `SELECT t.*,
            (SELECT count(*)::int FROM ${store.commentsTable} c WHERE c.task_id=t.id) AS comment_count
       FROM ${store.tasksTable} t
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE ${where}
      ORDER BY t.archived_at NULLS FIRST, t.updated_at DESC, t.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = Number(count.rows[0]?.total ?? 0);
  return pageResult(result.rows.map(rowToTask), page, pageSize, total);
}

export async function searchComments(
  store: TaskboardSearchStore,
  identity: TaskboardIdentity,
  taskId: string,
  filter: TaskboardPageFilter = {},
): Promise<TaskboardPage<TaskBoardComment>> {
  const access = await store.pool.query(
    `SELECT 1
       FROM ${store.tasksTable} t
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  if (!access.rows[0]) throw new TaskboardNotFoundError('Task not found');
  const { page, pageSize, offset } = normalizePage(filter.page, filter.pageSize);
  const accessParams = [taskId, identity.tenantId, identity.ownerUserId];
  const count = await store.pool.query(
    `SELECT count(*)::int AS total
       FROM ${store.commentsTable} c
       JOIN ${store.tasksTable} t ON t.id=c.task_id
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE c.task_id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    accessParams,
  );
  const result = await store.pool.query(
    `SELECT c.*
       FROM ${store.commentsTable} c
       JOIN ${store.tasksTable} t ON t.id=c.task_id
       JOIN ${store.boardsTable} b ON b.id=t.board_id
      WHERE c.task_id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')
      ORDER BY c.created_at, c.id
      LIMIT $4 OFFSET $5`,
    [...accessParams, pageSize, offset],
  );
  const total = Number(count.rows[0]?.total ?? 0);
  return pageResult(
    result.rows.map((row) => applyCommentAuthorDisplayName(rowToComment(row), identity)),
    page,
    pageSize,
    total,
  );
}

export function normalizePage(pageInput?: number, pageSizeInput?: number): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const page = Math.max(1, Math.floor(pageInput ?? 1));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(pageSizeInput ?? DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageResult<T>(items: T[], page: number, pageSize: number, total: number): TaskboardPage<T> {
  return { items, page, pageSize, total, hasMore: page * pageSize < total };
}
