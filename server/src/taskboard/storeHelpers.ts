import {
  type TaskBoard,
  type TaskBoardComment,
  type TaskBoardExecution,
  type TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import {
  TaskboardConflictError,
  type TaskboardExecutionDispatch,
  TaskboardValidationError,
} from './types.js';

export function rowToTask(row: Record<string, unknown>): TaskBoardTask {
  return {
    id: String(row.id),
    boardId: String(row.board_id),
    identifier: String(row.identifier),
    title: String(row.title),
    description: String(row.description ?? ''),
    status: String(row.status) as TaskBoardTask['status'],
    priority: String(row.priority) as TaskBoardTask['priority'],
    labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
    sortOrder: Number(row.sort_order),
    ...(row.due_at ? { dueAt: toIso(row.due_at) } : {}),
    ...(row.model !== null && row.model !== undefined && String(row.model).trim()
      ? { model: String(row.model) }
      : {}),
    commentCount: Number(row.comment_count ?? 0),
    version: Number(row.version),
    ...(row.archived_at ? { archivedAt: toIso(row.archived_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function rowToComment(row: Record<string, unknown>): TaskBoardComment {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    body: String(row.body),
    authorType: String(row.author_type) as TaskBoardComment['authorType'],
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function rowToExecution(row: Record<string, unknown>): TaskBoardExecution {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    status: String(row.status) as TaskBoardExecution['status'],
    requestedBy: String(row.requested_by),
    ...(row.error !== null && row.error !== undefined ? { error: String(row.error) } : {}),
    ...(row.started_at ? { startedAt: toIso(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: toIso(row.finished_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function rowToExecutionDispatch(row: Record<string, unknown>): TaskboardExecutionDispatch {
  if (typeof row.lease_id !== 'string' || !row.lease_id) {
    throw new Error(`任务看板执行派发 lease 无效：${String(row.run_id)}`);
  }
  return {
    runId: String(row.run_id),
    executionId: String(row.actual_execution_id),
    outboxExecutionId: String(row.execution_id),
    taskId: String(row.actual_task_id),
    sessionId: String(row.actual_session_id),
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    payload: row.payload as TaskboardExecutionDispatch['payload'],
    attemptCount: Number(row.attempt_count),
    leaseId: row.lease_id,
  };
}

export function isTerminalExecutionStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function assertActiveBoard(board: TaskBoard): void {
  if (board.archivedAt) {
    throw new TaskboardValidationError('Archived boards are read-only', 'TASKBOARD_BOARD_ARCHIVED');
  }
}

export function assertWritableTask(task: TaskBoardTask, boardArchivedAt?: string): void {
  if (boardArchivedAt) {
    throw new TaskboardValidationError('Archived boards are read-only', 'TASKBOARD_BOARD_ARCHIVED');
  }
  if (task.archivedAt) {
    throw new TaskboardValidationError('Archived tasks are read-only', 'TASKBOARD_TASK_ARCHIVED');
  }
}

export function assertExpectedVersion<T extends TaskBoard | TaskBoardTask>(current: T, expectedVersion: number): void {
  if (current.version !== expectedVersion) throw new TaskboardConflictError(current);
}

export function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TaskboardValidationError(`${label} is required`);
  return normalized;
}

export function optionalText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  return normalized || null;
}

export function normalizeLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.trim()).filter(Boolean))];
}

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

export function mapActiveBoardNameError(error: unknown): unknown {
  if (isUniqueViolation(error)) {
    return new TaskboardValidationError(
      'An active board with this name already exists',
      'TASKBOARD_BOARD_NAME_EXISTS',
    );
  }
  return error;
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505');
}
