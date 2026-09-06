import type { TaskBoardComment, TaskBoardContextCommentMode } from '../../../shared/src/types/taskboard.js';
import {
  applyCommentAuthorDisplayName,
  commentExecutionJoin,
  rowToComment,
  visibleCommentPredicate,
} from './storeHelpers.js';
import { normalizePage, pageResult, type TaskboardSearchStore } from './storeSearch.js';
import { TaskboardNotFoundError, TaskboardValidationError } from './types.js';
import type {
  TaskboardCommentSearchFilter,
  TaskboardIdentity,
  TaskboardPage,
} from './types.js';

/**
 * 评论定位与投影。
 *
 * 背景：`comment.list` 原本只有 page/pageSize 且固定升序，模型要读「最近一条」必须
 * 先查 total 再算尾页；`execution.context` 则默认把全部评论正文塞进上下文（单条
 * execution.finish body 上限 20,000 字符），长任务一次就能吐出几百 KB。
 *
 * 这里统一提供三件事：稳定的窗口定位（order / latest / ordinal / commentId）、
 * 目录行投影（digest）、以及 execution.context 的「最近 N 条全文 + 更早目录行」。
 * ordinal 是当前可见集合内按 (created_at, id) 升序的 1-based 位置，用窗口函数现算，
 * 不落库；评论是硬删，删除会让后续 ordinal 左移，跨轮引用请用 comment id。
 */
export const COMMENT_PREVIEW_CHARS = 200;
export const MAX_LATEST_COMMENTS = 20;
/** mode=full 时的哨兵：大于任何真实评论条数，等价于全部取全文。 */
const ALL_COMMENTS_FULL = 2_147_483_647;

interface CommentQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface CommentQueryTables {
  commentsTable: string;
  changesTable: string;
  executionsTable: string;
}

function visibleCommentsCte(tables: CommentQueryTables, extraWhere = ''): string {
  return `WITH visible AS (
    SELECT c.*,
           row_number() OVER (ORDER BY c.created_at, c.id) AS ordinal,
           row_number() OVER (ORDER BY c.created_at DESC, c.id DESC) AS recency,
           count(*) OVER () AS total_count,
           char_length(c.body) AS body_chars
      FROM ${tables.commentsTable} c
     WHERE c.task_id=$1
       AND ${visibleCommentPredicate('c', tables.changesTable)}${extraWhere}
  )`;
}

function commentColumns(bodyExpr: string, truncatedExpr: string): string {
  return `v.id, v.task_id, v.attachments, v.author_type, v.author_id, v.author_name,
          v.version, v.created_at, v.updated_at, v.ordinal, v.total_count, v.body_chars,
          ${bodyExpr} AS body, ${truncatedExpr} AS body_is_truncated,
          comment_execution.comment_session_id, comment_execution.comment_execution_id,
          comment_execution.comment_execution_purpose`;
}

/**
 * 字符数一律按 Unicode code point 计，与 PostgreSQL `char_length` / `left` 同口径。
 * JS 的 `String.length` 数的是 UTF-16 code unit，emoji 等星平面字符会翻倍：
 * 两种口径混用会把「是否被截断」判反，切片还会把代理对切成孤立代理。
 */
export function codePointLength(text: string): number {
  return [...text].length;
}

/** 把行投影成评论；是否只是预览由 SQL 直接给出事实位，不靠长度比大小推断。 */
export function projectComment(
  row: Record<string, unknown>,
  identity?: TaskboardIdentity,
): TaskBoardComment {
  const base = rowToComment(row);
  const comment = identity ? applyCommentAuthorDisplayName(base, identity) : base;
  const bodyChars = Number(row.body_chars ?? codePointLength(comment.body));
  return {
    ...comment,
    ordinal: Number(row.ordinal),
    bodyChars,
    ...(row.body_is_truncated === true ? { bodyTruncated: true as const } : {}),
  };
}

/** 把一条完整评论降级为目录行；用于服务端预算兜底。 */
export function digestComment(comment: TaskBoardComment): TaskBoardComment {
  const codePoints = [...comment.body];
  const bodyChars = comment.bodyChars ?? codePoints.length;
  if (codePoints.length <= COMMENT_PREVIEW_CHARS) return { ...comment, bodyChars };
  return {
    ...comment,
    body: codePoints.slice(0, COMMENT_PREVIEW_CHARS).join(''),
    bodyChars,
    bodyTruncated: true,
  };
}

async function assertTaskVisible(
  store: TaskboardSearchStore,
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

async function countVisibleComments(store: TaskboardSearchStore, taskId: string): Promise<number> {
  const result = await store.pool.query(
    `SELECT count(*)::int AS total
       FROM ${store.commentsTable} c
      WHERE c.task_id=$1 AND ${visibleCommentPredicate('c', store.changesTable)}`,
    [taskId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

function assertLocatorInput(filter: TaskboardCommentSearchFilter): void {
  if (filter.ordinal !== undefined) {
    if (!Number.isInteger(filter.ordinal)) {
      throw new TaskboardValidationError('Comment ordinal must be an integer');
    }
    if (filter.ordinal === 0) {
      throw new TaskboardValidationError('Comment ordinal is 1-based; use negative values to count from the end');
    }
  }
  if (filter.latest !== undefined
    && (!Number.isInteger(filter.latest) || filter.latest < 1 || filter.latest > MAX_LATEST_COMMENTS)) {
    throw new TaskboardValidationError(`latest must be an integer between 1 and ${MAX_LATEST_COMMENTS}`);
  }
}

/**
 * 评论查询。定位参数优先级：commentId > ordinal > latest > page/pageSize。
 * 定位模式返回的 page/pageSize 只描述本次窗口；`hasMore` 表示任务里还有未返回的评论。
 */
export async function searchComments(
  store: TaskboardSearchStore,
  identity: TaskboardIdentity,
  taskId: string,
  filter: TaskboardCommentSearchFilter = {},
): Promise<TaskboardPage<TaskBoardComment>> {
  await assertTaskVisible(store, identity, taskId);
  assertLocatorInput(filter);
  const params: unknown[] = [taskId, identity.tenantId, identity.ownerUserId];
  const digest = filter.view === 'digest';
  const previewParam = digest ? `$${params.push(COMMENT_PREVIEW_CHARS)}` : '';
  const bodyExpr = digest ? `left(v.body, ${previewParam})` : 'v.body';
  const truncatedExpr = digest ? `v.body_chars > ${previewParam}` : 'false';
  const { page, pageSize, offset } = normalizePage(filter.page, filter.pageSize);
  const locating = Boolean(filter.commentId) || filter.ordinal !== undefined || filter.latest !== undefined;
  let where = '';
  let orderDir = filter.order === 'desc' ? 'DESC' : 'ASC';
  let limitClause = '';
  if (filter.commentId) {
    where = `WHERE v.id=$${params.push(filter.commentId)}`;
    orderDir = 'ASC';
  } else if (filter.ordinal !== undefined) {
    where = filter.ordinal > 0
      ? `WHERE v.ordinal=$${params.push(filter.ordinal)}`
      : `WHERE v.ordinal=v.total_count+1+$${params.push(filter.ordinal)}`;
    orderDir = 'ASC';
  } else if (filter.latest !== undefined) {
    where = `WHERE v.recency<=$${params.push(filter.latest)}`;
    orderDir = 'ASC';
  } else {
    limitClause = `LIMIT $${params.push(pageSize)} OFFSET $${params.push(offset)}`;
  }
  const result = await store.pool.query(
    `${visibleCommentsCte(
      store,
      ` AND EXISTS (
           SELECT 1 FROM ${store.tasksTable} t
             JOIN ${store.boardsTable} b ON b.id=t.board_id
            WHERE t.id=c.task_id AND b.tenant_id=$2
              AND (b.owner_user_id=$3 OR b.visibility='organization'))`,
    )}
     SELECT ${commentColumns(bodyExpr, truncatedExpr)}
       FROM visible v
       ${commentExecutionJoin(store.changesTable, store.executionsTable, 'v')}
     ${where}
     ORDER BY v.ordinal ${orderDir}
     ${limitClause}`,
    params,
  );
  const items = result.rows.map((row) => projectComment(row, identity));
  const total = result.rows[0]
    ? Number(result.rows[0].total_count)
    : await countVisibleComments(store, taskId);
  if (locating) {
    return {
      items,
      page: 1,
      pageSize: Math.max(1, items.length),
      total,
      hasMore: total > items.length,
    };
  }
  return pageResult(items, page, pageSize, total);
}

export interface ContextCommentsResult {
  comments: TaskBoardComment[];
  total: number;
}

/**
 * execution.context 用的评论加载：最近 fullCount 条给全文，更早的只给目录行，
 * 且最多返回 maxComments 条（更早的完全不返回，由 total 体现）。
 */
export async function loadContextComments(
  db: CommentQueryable,
  tables: CommentQueryTables,
  taskId: string,
  mode: TaskBoardContextCommentMode,
  limit: number,
  maxComments: number,
): Promise<ContextCommentsResult> {
  const fullCount = mode === 'full' ? ALL_COMMENTS_FULL : mode === 'digest' ? 0 : Math.max(0, limit);
  const result = await db.query(
    `${visibleCommentsCte(tables)}
     SELECT ${commentColumns(
      'CASE WHEN v.recency<=$2 THEN v.body ELSE left(v.body, $3) END',
      'CASE WHEN v.recency<=$2 THEN false ELSE v.body_chars > $3 END',
    )}
       FROM visible v
       ${commentExecutionJoin(tables.changesTable, tables.executionsTable, 'v')}
      WHERE v.recency<=$4
      ORDER BY v.ordinal ASC`,
    [taskId, fullCount, COMMENT_PREVIEW_CHARS, maxComments],
  );
  const comments = result.rows.map((row) => projectComment(row));
  return { comments, total: Number(result.rows[0]?.total_count ?? 0) };
}
