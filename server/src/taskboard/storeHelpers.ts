import {
  type TaskBoard,
  type TaskBoardAttachment,
  type TaskBoardComment,
  type TaskBoardExecution,
  type TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import {
  TaskboardConflictError,
  type TaskboardExecutionDispatch,
  type TaskboardExecutionModelContext,
  type TaskboardExecutionReconcileCandidate,
  type TaskboardIdentity,
  TaskboardValidationError,
} from './types.js';

export function rowToTask(row: Record<string, unknown>): TaskBoardTask {
  return {
    id: String(row.id),
    boardId: String(row.board_id),
    identifier: String(row.identifier),
    kind: row.kind === 'integration' || row.kind === 'remediation' ? row.kind : 'delivery',
    title: String(row.title),
    description: String(row.description ?? ''),
    ...(row.branch ? { branch: String(row.branch) } : {}),
    attachments: normalizeAttachments(row.attachments),
    status: String(row.status) as TaskBoardTask['status'],
    priority: String(row.priority) as TaskBoardTask['priority'],
    labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
    sortOrder: Number(row.sort_order),
    ...(row.due_at ? { dueAt: toIso(row.due_at) } : {}),
    ...(row.model !== null && row.model !== undefined && String(row.model).trim()
      ? { model: String(row.model) }
      : {}),
    ...(row.provider_pull_request_id ? { providerPullRequestId: String(row.provider_pull_request_id) } : {}),
    ...(row.pull_request_number !== null && row.pull_request_number !== undefined
      ? { pullRequestNumber: Number(row.pull_request_number) }
      : {}),
    ...(row.reviewed_subject_digest ? { reviewedSubjectDigest: String(row.reviewed_subject_digest) } : {}),
    ...(row.merged_commit_oid ? { mergedCommitOid: String(row.merged_commit_oid) } : {}),
    ...(row.integration_task_id ? { integrationTaskId: String(row.integration_task_id) } : {}),
    ...(row.integration_state ? {
      integrationState: String(row.integration_state) as TaskBoardTask['integrationState'],
    } : {}),
    commentCount: Number(row.comment_count ?? 0),
    version: Number(row.version),
    ...(row.creator_user_id ? { creatorUserId: String(row.creator_user_id) } : {}),
    ...(row.creator_name ? { creatorName: String(row.creator_name) } : {}),
    ...(row.completed_at ? { completedAt: toIso(row.completed_at) } : {}),
    ...(row.archived_at ? { archivedAt: toIso(row.archived_at) } : {}),
    ...(row.deleted_at ? { deletedAt: toIso(row.deleted_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function rowToComment(row: Record<string, unknown>): TaskBoardComment {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    body: String(row.body),
    attachments: normalizeAttachments(row.attachments),
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
    purpose: row.purpose === 'review' || row.purpose === 'merge' ? row.purpose : 'work',
    trigger: row.trigger === 'comment' || row.trigger === 'resume' || row.trigger === 'retry'
      ? row.trigger
      : 'initial',
    protocolVersion: Number(row.protocol_version) === 2 ? 2 : 1,
    ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}),
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

export function assertExpectedVersion<T extends TaskBoard | TaskBoardTask | TaskBoardComment>(current: T, expectedVersion: number): void {
  if (current.version !== expectedVersion) throw new TaskboardConflictError(current);
}

export function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TaskboardValidationError(`${label} is required`);
  return normalized;
}

export function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

export function normalizeLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.trim()).filter(Boolean))];
}

export function normalizeAttachments(value: unknown): TaskBoardAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const attachment = entry as Record<string, unknown>;
    const originalName = typeof attachment.originalName === 'string' ? attachment.originalName.trim() : '';
    const relativePath = typeof attachment.relativePath === 'string' ? attachment.relativePath.trim() : '';
    if (!originalName || !relativePath) return [];
    return [{
      ...(typeof attachment.attachmentId === 'string' && attachment.attachmentId
        ? { attachmentId: attachment.attachmentId }
        : {}),
      originalName,
      relativePath,
      size: Number.isFinite(Number(attachment.size)) ? Math.max(0, Number(attachment.size)) : 0,
      mimeType: typeof attachment.mimeType === 'string' && attachment.mimeType
        ? attachment.mimeType
        : 'application/octet-stream',
      isImage: attachment.isImage === true,
    }];
  });
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

const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const LONGEST_TASKBOARD_IDENTIFIER_SUFFIX = '_taskboard_tasks_board_id_identifier_key';
export const TASKBOARD_TABLE_PREFIX_MAX_LENGTH =
  POSTGRES_IDENTIFIER_MAX_BYTES - LONGEST_TASKBOARD_IDENTIFIER_SUFFIX.length;

export function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  if (Buffer.byteLength(value, 'utf8') > TASKBOARD_TABLE_PREFIX_MAX_LENGTH) {
    throw new Error(
      `PostgreSQL table prefix is too long for taskboard identifiers: max ${TASKBOARD_TABLE_PREFIX_MAX_LENGTH} bytes`,
    );
  }
  return value;
}

export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}


export function assertExecutionConfiguration(
  currentModelRef: string | undefined,
  requestedModelRef: string | undefined,
  currentOwnerUserId: string,
  requestedOwnerUserId: string,
): void {
  if (currentModelRef !== requestedModelRef) {
    throw new TaskboardValidationError(
      '任务或看板的运行模型已变化，请重试',
      'TASKBOARD_EXECUTION_MODEL_CHANGED',
    );
  }
  if (currentOwnerUserId !== requestedOwnerUserId) {
    throw new TaskboardValidationError(
      '任务执行上下文与看板创建者不一致，请重试',
      'TASKBOARD_EXECUTION_OWNER_CHANGED',
    );
  }
}

export function validateMoveNeighbors(
  peers: Array<{ id: string; sortOrder: number }>,
  previousTaskId?: string,
  nextTaskId?: string,
): void {
  const previousIndex = previousTaskId ? peers.findIndex((peer) => peer.id === previousTaskId) : -1;
  const nextIndex = nextTaskId ? peers.findIndex((peer) => peer.id === nextTaskId) : -1;
  if ((previousTaskId && previousIndex < 0) || (nextTaskId && nextIndex < 0)) {
    throw new TaskboardValidationError('Move neighbor is not an active task in the target column', 'TASKBOARD_INVALID_MOVE');
  }
  const valid = previousTaskId && nextTaskId
    ? nextIndex === previousIndex + 1
    : previousTaskId
      ? previousIndex === peers.length - 1
      : nextTaskId
        ? nextIndex === 0
        : peers.length === 0;
  if (!valid) {
    throw new TaskboardValidationError('Move neighbors are stale or not adjacent', 'TASKBOARD_INVALID_MOVE');
  }
}

export function applyCommentAuthorDisplayName(
  comment: TaskBoardComment,
  identity: TaskboardIdentity,
): TaskBoardComment {
  if (
    identity.displayName
    && comment.authorType === 'user'
    && comment.authorId === identity.ownerUserId
  ) {
    return { ...comment, authorName: identity.displayName };
  }
  return comment;
}

export function rowToExecutionModelContext(
  row: Record<string, unknown>,
): TaskboardExecutionModelContext {
  return {
    ...(row.task_model ? { taskModel: String(row.task_model) } : {}),
    ...(row.board_model ? { boardModel: String(row.board_model) } : {}),
    ...(row.task_kind === 'integration' || row.task_kind === 'remediation'
      ? { taskKind: row.task_kind }
      : { taskKind: 'delivery' as const }),
    ...(row.task_status ? { taskStatus: String(row.task_status) as TaskBoardTask['status'] } : {}),
    ...(row.policy_revision ? { policyRevision: String(row.policy_revision) } : {}),
    boardOwnerUserId: String(row.board_owner_user_id),
    ...(row.board_id ? { boardId: String(row.board_id) } : {}),
    ...(row.board_name ? { boardName: String(row.board_name) } : {}),
  };
}

export function rowToExecutionReconcileCandidate(
  row: Record<string, unknown>,
): TaskboardExecutionReconcileCandidate {
  return {
    runId: String(row.run_id),
    executionId: String(row.execution_id),
    sessionId: String(row.session_id),
    executionStatus: String(row.status) as TaskboardExecutionReconcileCandidate['executionStatus'],
    leaseId: String(row.reconcile_lease_id),
    ...(row.dispatch_status ? {
      dispatchStatus: String(row.dispatch_status) as TaskboardExecutionReconcileCandidate['dispatchStatus'],
    } : {}),
  };
}
