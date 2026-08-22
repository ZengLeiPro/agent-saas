import {
  type TaskBoard,
  type TaskBoardAttachment,
  type TaskBoardComment,
  type TaskBoardExecution,
  type TaskBoardResumeContext,
  type TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import {
  TaskboardConflictError,
  TaskboardPermissionError,
  type TaskboardExecutionDispatch,
  type TaskboardExecutionModelContext,
  type TaskboardExecutionReconcileCandidate,
  type TaskboardIdentity,
  TaskboardValidationError,
} from './types.js';
import { parseJsonObject, parseStageModels } from './boardFields.js';

export function rowToTask(row: Record<string, unknown>): TaskBoardTask {
  if (row.kind !== null && row.kind !== undefined
    && !['delivery', 'advisory', 'integration', 'remediation'].includes(String(row.kind))) {
    throw new TaskboardValidationError(
      `Unsupported task kind: ${String(row.kind)}`,
      'TASKBOARD_TASK_KIND_UNSUPPORTED',
    );
  }
  return {
    id: String(row.id),
    boardId: String(row.board_id),
    identifier: String(row.identifier),
    ...(row.kind === null || row.kind === undefined
      ? { kind: 'delivery' as const }
      : row.kind === 'delivery' || row.kind === 'advisory' || row.kind === 'integration' || row.kind === 'remediation'
        ? { kind: row.kind }
        : {}),
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
    ...(Object.keys(parseStageModels(row.stage_models)).length
      ? { stageModels: parseStageModels(row.stage_models) }
      : {}),
    ...(row.provider_pull_request_id ? { providerPullRequestId: String(row.provider_pull_request_id) } : {}),
    ...(row.pull_request_number !== null && row.pull_request_number !== undefined
      ? { pullRequestNumber: Number(row.pull_request_number) }
      : {}),
    ...(row.reviewed_subject_digest ? { reviewedSubjectDigest: String(row.reviewed_subject_digest) } : {}),
    ...(row.provider_ci_inspection_id ? { providerCiInspectionId: String(row.provider_ci_inspection_id) } : {}),
    ...(row.provider_ci_execution_id ? { providerCiExecutionId: String(row.provider_ci_execution_id) } : {}),
    ...(row.provider_ci_purpose ? {
      providerCiPurpose: String(row.provider_ci_purpose) as TaskBoardTask['providerCiPurpose'],
    } : {}),
    ...(row.provider_ci_head_oid ? { providerCiHeadOid: String(row.provider_ci_head_oid) } : {}),
    ...(row.provider_ci_status ? {
      providerCiStatus: String(row.provider_ci_status) as TaskBoardTask['providerCiStatus'],
    } : {}),
    ...(row.provider_ci_inspected_at ? { providerCiInspectedAt: toIso(row.provider_ci_inspected_at) } : {}),
    ...(row.merged_commit_oid ? { mergedCommitOid: String(row.merged_commit_oid) } : {}),
    ...(row.integration_task_id ? { integrationTaskId: String(row.integration_task_id) } : {}),
    ...(row.integration_task_identifier ? { integrationTaskIdentifier: String(row.integration_task_identifier) } : {}),
    ...(row.integration_task_title ? { integrationTaskTitle: String(row.integration_task_title) } : {}),
    ...(row.integration_source_id ? { integrationSourceId: String(row.integration_source_id) } : {}),
    ...(row.root_delivery_task_id ? { rootDeliveryTaskId: String(row.root_delivery_task_id) } : {}),
    ...(row.root_delivery_task_identifier ? { rootDeliveryTaskIdentifier: String(row.root_delivery_task_identifier) } : {}),
    ...(row.root_delivery_task_title ? { rootDeliveryTaskTitle: String(row.root_delivery_task_title) } : {}),
    ...(row.integration_state ? {
      integrationState: String(row.integration_state) as TaskBoardTask['integrationState'],
    } : {}),
    ...(row.kind === 'integration'
      ? { workflowVersion: row.workflow_version === null || row.workflow_version === undefined
          ? 2 as const
          : Number(row.workflow_version) as 2 | 3 }
      : {}),
    mergeEligibility: taskMergeEligibility(row),
    workflowDisplayState: taskWorkflowDisplayState(row),
    ...taskResumeContext(row.resume_context),
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

function taskResumeContext(value: unknown): { resumeContext: TaskBoardResumeContext } | Record<string, never> {
  const context = parseJsonObject<Record<string, unknown>>(value);
  if (!context || typeof context.decision !== 'string' || !context.decision.trim()
    || !['work', 'review', 'merge'].includes(String(context.purpose))
    || typeof context.requestedAt !== 'string' || typeof context.requestedBy !== 'string') {
    return {};
  }
  return {
    resumeContext: {
      decision: context.decision,
      purpose: String(context.purpose) as TaskBoardResumeContext['purpose'],
      sourceIds: Array.isArray(context.sourceIds) ? context.sourceIds.map(String) : [],
      requestedAt: context.requestedAt,
      requestedBy: context.requestedBy,
      ...(typeof context.consumedAt === 'string' ? { consumedAt: context.consumedAt } : {}),
      ...(typeof context.consumedExecutionId === 'string'
        ? { consumedExecutionId: context.consumedExecutionId }
        : {}),
    },
  };
}

function taskMergeEligibility(row: Record<string, unknown>): TaskBoardTask['mergeEligibility'] {
  if (row.kind !== 'delivery') return 'not_applicable';
  if (row.integration_state === 'merged' || row.merged_commit_oid) return 'merged';
  if (row.integration_state !== 'canceled' && (row.integration_source_id || row.integration_task_id)) return 'claimed';
  const inspectedAt = row.provider_ci_inspected_at ? new Date(String(row.provider_ci_inspected_at)).getTime() : 0;
  const inspectionFresh = Number.isFinite(inspectedAt) && Date.now() - inspectedAt <= 10 * 60 * 1000;
  return row.status === 'ready_to_merge'
    && row.provider_pull_request_id
    && row.reviewed_subject_digest
    && row.provider_ci_status === 'success'
    && row.provider_ci_purpose === 'review'
    && row.provider_ci_head_oid === row.head_oid
    && inspectionFresh
    ? 'eligible'
    : 'not_applicable';
}

function taskWorkflowDisplayState(row: Record<string, unknown>): string {
  if (row.kind === 'remediation' && row.status === 'done') return 'remediation_accepted';
  if (row.integration_state && !['merged', 'canceled'].includes(String(row.integration_state))) return 'claimed_for_integration';
  return String(row.status);
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
    ...(row.comment_session_id ? { sessionId: String(row.comment_session_id) } : {}),
    ...(row.comment_execution_id ? { executionId: String(row.comment_execution_id) } : {}),
    ...(row.comment_execution_purpose === 'review' || row.comment_execution_purpose === 'merge'
      ? { executionPurpose: row.comment_execution_purpose }
      : row.comment_execution_purpose === 'work' ? { executionPurpose: 'work' as const } : {}),
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function commentExecutionJoin(
  changesTable: string,
  executionsTable: string,
  commentAlias = 'c',
): string {
  return `LEFT JOIN LATERAL (
    SELECT e.id AS comment_execution_id, e.session_id AS comment_session_id, e.purpose AS comment_execution_purpose
      FROM ${executionsTable} e
     WHERE e.run_id=${commentAlias}.continuation_run_id
    UNION ALL
    SELECT e.id AS comment_execution_id, e.session_id AS comment_session_id, e.purpose AS comment_execution_purpose
      FROM ${changesTable} execution_comment
      JOIN ${executionsTable} e ON e.run_id=execution_comment.actor_id
     WHERE execution_comment.task_id=${commentAlias}.task_id
       AND execution_comment.change_type='execution.comment'
       AND execution_comment.payload->>'commentId'=${commentAlias}.id
    LIMIT 1
  ) comment_execution ON true`;
}

export function visibleCommentPredicate(commentAlias: string, changesTable: string): string {
  return `(${commentAlias}.author_type='user' OR EXISTS (
    SELECT 1 FROM ${changesTable} execution_comment
     WHERE execution_comment.task_id=${commentAlias}.task_id
       AND execution_comment.change_type='execution.comment'
       AND execution_comment.payload->>'commentId'=${commentAlias}.id
  ))`;
}

function executionResolutionProjection(row: Record<string, unknown>): Pick<TaskBoardExecution, 'resolutionState' | 'resolutionIssue'> {
  if (row.has_resolution === true || row.resolution_id || row.resolution_outcome) {
    return { resolutionState: row.resolution_historical === true ? 'historical' : 'canonical' };
  }
  const candidates = Number(row.legacy_resolution_count ?? 0);
  const valid = Number(row.legacy_resolution_valid_count ?? 0);
  if (candidates > 1) {
    return {
      resolutionState: 'legacy_ambiguous',
      resolutionIssue: `检测到 ${candidates} 条历史结论，无法唯一迁移`,
    };
  }
  if (candidates === 1 && valid !== 1) {
    return {
      resolutionState: 'legacy_incomplete',
      resolutionIssue: '历史结论字段不完整，未迁移为结构化结论',
    };
  }
  return { resolutionState: 'missing' };
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
    ...(row.resolution_id ? { resolutionId: String(row.resolution_id) } : {}),
    ...(row.resolution_outcome ? { resolutionOutcome: String(row.resolution_outcome) } : {}),
    ...(row.resolution_summary ? { resolutionSummary: String(row.resolution_summary) } : {}),
    ...executionResolutionProjection(row),
    ...(row.task_status_after ? { taskStatusAfter: String(row.task_status_after) as TaskBoardTask['status'] } : {}),
    ...(row.resolved_at ? { resolvedAt: toIso(row.resolved_at) } : {}),
    ...(row.ignored_reason ? { ignoredReason: String(row.ignored_reason) } : {}),
    ...(row.superseded_at ? { supersededAt: toIso(row.superseded_at) } : {}),
    ...(row.fence_epoch !== null && row.fence_epoch !== undefined ? { fenceEpoch: String(row.fence_epoch) } : {}),
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

export function assertBoardRole(
  role: TaskBoard['role'],
  minimum: 'editor' | 'maintainer' | 'owner',
): void {
  const rank = role === 'owner' ? 4 : role === 'maintainer' ? 3 : role === 'editor' ? 2 : 1;
  const required = minimum === 'owner' ? 4 : minimum === 'maintainer' ? 3 : 2;
  if (rank < required) {
    throw new TaskboardPermissionError('Taskboard role does not allow this operation');
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
    ...(Object.keys(parseStageModels(row.task_stage_models)).length
      ? { taskStageModels: parseStageModels(row.task_stage_models) }
      : {}),
    ...(row.board_model ? { boardModel: String(row.board_model) } : {}),
    ...(Object.keys(parseStageModels(row.board_stage_models)).length
      ? { boardStageModels: parseStageModels(row.board_stage_models) }
      : {}),
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
