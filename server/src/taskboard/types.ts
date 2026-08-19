import type {
  TaskBoard,
  TaskBoardAttachment,
  TaskBoardAllowedAction,
  TaskBoardComment,
  TaskBoardCommentCreateInput,
  TaskBoardCommentPatchInput,
  TaskBoardCreateInput,
  TaskBoardExecution,
  TaskBoardExecutionPurpose,
  TaskBoardExecutionContextInput,
  TaskBoardExecutionContextResponse,
  TaskBoardExecutionResolutionInput,
  TaskBoardIntegrationBatchCreateInput,
  TaskBoardIntegrationCandidateDetails,
  TaskBoardIntegrationSource,
  TaskBoardMember,
  TaskBoardMemberPatchInput,
  TaskBoardExecutionStartInput,
  TaskBoardExecutionStartResult,
  TaskBoardExecutionStatus,
  TaskBoardPatchInput,
  TaskBoardPriority,
  TaskBoardStatus,
  TaskBoardStageModels,
  TaskBoardTask,
  TaskBoardTaskKind,
  TaskBoardTaskCreateInput,
  TaskBoardTaskMoveInput,
  TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';
import type { UpsertRunInput } from '../runtime/runStore.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';

export interface TaskboardIdentity {
  tenantId: string;
  ownerUserId: string;
  username: string;
  /** 展示用全名（如「曾磊 @zenglei」）；缺省时回退 username。 */
  displayName?: string;
  userRole?: "admin" | "user";
}

export interface TaskboardPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface TaskboardPageFilter {
  page?: number;
  pageSize?: number;
}

export interface TaskboardBoardSearchFilter extends TaskboardPageFilter {
  includeArchived?: boolean;
  search?: string;
}

export interface TaskboardTaskListFilter {
  includeArchived?: boolean;
  search?: string;
  statuses?: TaskBoardStatus[];
  kinds?: TaskBoardTaskKind[];
  priorities?: TaskBoardPriority[];
}

export interface TaskboardTaskSearchFilter extends TaskboardTaskListFilter, TaskboardPageFilter {
  boardId?: string;
  boardName?: string;
  labels?: string[];
  creatorUserId?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  dueAfter?: string;
  dueBefore?: string;
}

export interface TaskboardExpectedVersionInput {
  expectedVersion: number;
}

export interface TaskboardIntegrationSourceInspection {
  source: TaskBoardIntegrationSource;
  pullRequest: {
    providerPullRequestId: string;
    number: number;
    state: 'open' | 'closed' | 'merged';
    draft: boolean;
    headRef: string;
    headOid: string;
    baseRef: string;
    baseOid: string;
    mergeable: boolean | null;
    mergeableState?: string;
    requiredChecks: Array<{ name: string; status: 'pending' | 'success' | 'failure' }>;
    subjectDigest: string;
  };
}

export interface TaskboardIntegrationDispatchCandidate {
  identity: TaskboardIdentity;
  task: TaskBoardTask;
  purpose: TaskBoardExecutionPurpose;
}

export interface TaskboardIntegrationMergeResult {
  source: TaskBoardIntegrationSource;
  task: TaskBoardTask;
  receipt: Record<string, unknown>;
}

export interface TaskboardExecutionDispatchPayload {
  version: 1;
  session: RuntimeSessionRecord;
  run: UpsertRunInput;
}

export interface TaskboardContinuationDispatchPayload {
  version: 1;
  session: RuntimeSessionRecord;
  run: UpsertRunInput;
}

export interface TaskboardContinuationDispatch {
  runId: string;
  taskId: string;
  commentId: string;
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  payload: TaskboardContinuationDispatchPayload;
  attemptCount: number;
  leaseId: string;
}

export interface TaskboardContinuationReconcileCandidate {
  runId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
}

export interface TaskboardExecutionClaimInput extends TaskBoardExecutionStartInput {
  executionId: string;
  trigger?: 'initial' | 'comment' | 'resume' | 'retry';
  protocolVersion?: 1 | 2;
  attemptId?: string;
  policyRevision?: string;
  contextStartSeq?: string;
  subjectDigest?: string;
  laneEpoch?: bigint;
  runId: string;
  sessionId: string;
  /** startExecution 读取到的任务/看板显式模型；claim 锁内复核，防止并发改模型。 */
  configuredModelRef?: string;
  /** Agent 实际继承的看板创建者；claim 锁内复核，防止错误使用发起者上下文。 */
  executionOwnerUserId: string;
  dispatch: TaskboardExecutionDispatchPayload;
}

export interface TaskboardExecutionDispatch {
  runId: string;
  executionId: string;
  outboxExecutionId: string;
  taskId: string;
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  payload: TaskboardExecutionDispatchPayload;
  attemptCount: number;
  leaseId: string;
}

export interface TaskboardExecutionReconcileCandidate {
  runId: string;
  executionId: string;
  sessionId: string;
  executionStatus: TaskBoardExecutionStatus;
  dispatchStatus?: 'pending' | 'dispatching' | 'dispatched';
  leaseId: string;
}

export interface TaskboardExecutionModelContext {
  taskModel?: string;
  boardModel?: string;
  /** 看板按执行阶段配置的默认模型；解析优先级：任务模型 > 阶段模型 > 看板模型。 */
  boardStageModels?: TaskBoardStageModels;
  taskKind?: 'delivery' | 'integration' | 'remediation';
  taskStatus?: TaskBoardStatus;
  policyRevision?: string;
  boardOwnerUserId: string;
  boardId?: string;
  boardName?: string;
  allowedActions?: TaskBoardAllowedAction[];
}

export interface TaskboardExecutionContext {
  identity: TaskboardIdentity;
  task: TaskBoardTask;
  boardPrompt: string;
  /** 各执行阶段（work/review/merge）特定提示语；与 boardPrompt 并存。 */
  stagePrompts?: Partial<Record<TaskBoardExecutionPurpose, string>>;
  comments: TaskBoardComment[];
  execution: TaskBoardExecution;
  continuation?: boolean;
}

export interface TaskboardContinuationContext {
  task: TaskBoardTask;
  comment: TaskBoardComment;
  pendingComments: TaskBoardComment[];
  /** 看板各执行阶段（work/review/merge）特定提示语；缺省阶段执行时使用系统固定模板。 */
  stagePrompts?: Partial<Record<TaskBoardExecutionPurpose, string>>;
  continuationRunId?: string;
  hasActiveContinuation?: boolean;
  activeExecution?: TaskBoardExecution;
  continuationExecution?: TaskBoardExecution;
  latestExecution?: TaskBoardExecution;
}

export interface TaskboardExecutionCompletionInput {
  status: "succeeded" | "failed" | "cancelled";
  commentBody: string;
  attachments?: TaskBoardAttachment[];
  error?: string;
  /** 实施成功时与终态回写同事务创建的自动复核 Execution。 */
  reviewExecution?: TaskboardExecutionClaimInput;
}

export interface TaskboardWorkflowCancellation {
  id: string;
  runId: string;
  reason: string;
}

export interface TaskboardExecutionStore {
  claimWorkflowCancellations?(limit?: number): Promise<TaskboardWorkflowCancellation[]>;
  finishWorkflowCancellation?(id: string, error?: string): Promise<void>;
  reconcileMergeOperationsV2?(limit?: number): Promise<number>;
  claimIntegrationDispatchCandidatesV2?(limit?: number): Promise<TaskboardIntegrationDispatchCandidate[]>;
  listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]>;
  searchExecutions(
    identity: TaskboardIdentity,
    taskId: string,
    filter?: TaskboardPageFilter,
  ): Promise<TaskboardPage<TaskBoardExecution>>;
  getExecutionModelContext(
    identity: TaskboardIdentity,
    taskId: string,
  ): Promise<TaskboardExecutionModelContext>;
  claimExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExecutionClaimInput,
  ): Promise<TaskBoardExecutionStartResult>;
  getExecutionContextByRunId(runId: string): Promise<TaskboardExecutionContext | null>;
  getContinuationContext(
    identity: TaskboardIdentity,
    taskId: string,
    commentId: string,
  ): Promise<TaskboardContinuationContext>;
  enqueueContinuation(
    taskId: string,
    commentIds: string[],
    runId: string,
    commentId: string,
    payload: TaskboardContinuationDispatchPayload,
  ): Promise<boolean>;
  claimContinuationDispatch(
    runId: string | undefined,
    leaseId: string,
  ): Promise<TaskboardContinuationDispatch | null>;
  markContinuationDispatchSucceeded(runId: string, leaseId: string): Promise<boolean>;
  retryContinuationDispatch(
    runId: string,
    leaseId: string,
    error: string,
    delayMs: number,
  ): Promise<boolean>;
  claimContinuationReconcileCandidates(
    staleBefore: Date,
    limit: number,
    leaseId: string,
  ): Promise<TaskboardContinuationReconcileCandidate[]>;
  releaseContinuationReconcile(runId: string, leaseId: string): Promise<boolean>;
  finishContinuation(runId: string, leaseId?: string): Promise<boolean>;
  markContinuationRunning(taskId: string, runId: string, reconcileLeaseId?: string): Promise<TaskBoardTask | null>;
  completeContinuation(
    taskId: string,
    runId: string,
    input: TaskboardExecutionCompletionInput,
  ): Promise<TaskBoardTask | null>;
  getExecutionContextBySessionId(sessionId: string): Promise<TaskboardExecutionContext | null>;
  updateTaskBranchFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    branch: string | null,
  ): Promise<TaskBoardTask>;
  createTaskFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    input: TaskBoardTaskCreateInput,
  ): Promise<TaskBoardTask>;
  moveTaskFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    status: Extract<TaskBoardStatus, 'ready_to_merge' | 'todo' | 'blocked'>,
  ): Promise<TaskBoardTask>;
  claimExecutionDispatch(runId: string | undefined, leaseId: string): Promise<TaskboardExecutionDispatch | null>;
  markExecutionDispatchSucceeded(runId: string, leaseId: string): Promise<boolean>;
  retryExecutionDispatch(runId: string, leaseId: string, error: string, delayMs: number): Promise<boolean>;
  claimExecutionReconcileCandidates(
    staleBefore: Date,
    limit: number,
    leaseId: string,
  ): Promise<TaskboardExecutionReconcileCandidate[]>;
  setExecutionStatus(
    runId: string,
    status: Extract<TaskBoardExecutionStatus, "running" | "waiting_user" | "waiting_approval">,
  ): Promise<TaskBoardExecution | null>;
  setExecutionStatusFromReconcile(
    runId: string,
    status: Extract<TaskBoardExecutionStatus, "running" | "waiting_user" | "waiting_approval">,
    leaseId: string,
  ): Promise<TaskBoardExecution | null>;
  completeExecution(
    runId: string,
    input: TaskboardExecutionCompletionInput,
  ): Promise<TaskBoardExecutionStartResult | null>;
  completeExecutionFromReconcile(
    runId: string,
    input: TaskboardExecutionCompletionInput,
    leaseId: string,
  ): Promise<TaskBoardExecutionStartResult | null>;
}

export interface TaskboardIntegrationPushIssueInput {
  executionId: string;
  candidateId: string;
  ttlMs?: number;
}

export interface TaskboardIntegrationPushInput {
  executionId: string;
  candidateId: string;
  capabilityToken: string;
  /** The only git selector accepted from an Agent. Ref, remote and path are server-resolved. */
  commitOid: string;
}

export interface TaskboardIntegrationPushService {
  health(): Promise<{ enabled: boolean; healthy: boolean; reason?: string }>;
  issue(identity: TaskboardIdentity, input: TaskboardIntegrationPushIssueInput): Promise<{
    capabilityToken: string;
    expiresAt: string;
  }>;
  push(identity: TaskboardIdentity, input: TaskboardIntegrationPushInput): Promise<{
    pushed: true;
    candidateId: string;
    commitOid: string;
  }>;
}

export interface TaskboardExecutionService {
  listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]>;
  searchExecutions(
    identity: TaskboardIdentity,
    taskId: string,
    filter?: TaskboardPageFilter,
  ): Promise<TaskboardPage<TaskBoardExecution>>;
  startExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardExecutionStartInput,
  ): Promise<TaskBoardExecutionStartResult>;
  startDirectExecution?(
    identity: TaskboardIdentity,
    taskId: string,
    expectedVersion: number,
  ): Promise<TaskBoardExecutionStartResult>;
  continueExecution?(
    identity: TaskboardIdentity,
    taskId: string,
    commentId: string,
  ): Promise<TaskBoardExecutionStartResult>;
}

export interface TaskboardIntegrationCandidateView extends TaskBoardIntegrationCandidateDetails {
  operations: Array<{
    id: string;
    operationKey: string;
    kind: string;
    state: string;
    attemptCount: number;
    error?: string;
    receipt?: Record<string, unknown>;
    updatedAt: string;
  }>;
  worker: { status: string; checkpoint: Record<string, unknown>; error?: string };
}

export interface TaskboardService {
  listBoards(identity: TaskboardIdentity, includeArchived?: boolean): Promise<TaskBoard[]>;
  searchBoards(identity: TaskboardIdentity, filter?: TaskboardBoardSearchFilter): Promise<TaskboardPage<TaskBoard>>;
  getBoard(identity: TaskboardIdentity, boardId: string): Promise<TaskBoard>;
  createBoard(identity: TaskboardIdentity, input: TaskBoardCreateInput): Promise<TaskBoard>;
  updateBoard(identity: TaskboardIdentity, boardId: string, input: TaskBoardPatchInput): Promise<TaskBoard>;
  archiveBoard(identity: TaskboardIdentity, boardId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoard>;
  restoreBoard(identity: TaskboardIdentity, boardId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoard>;

  listTasks(identity: TaskboardIdentity, boardId: string, filter?: TaskboardTaskListFilter): Promise<TaskBoardTask[]>;
  searchTasks(identity: TaskboardIdentity, filter?: TaskboardTaskSearchFilter): Promise<TaskboardPage<TaskBoardTask>>;
  createTask(identity: TaskboardIdentity, boardId: string, input: TaskBoardTaskCreateInput): Promise<TaskBoardTask>;
  getTask(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardTask>;
  updateTask(identity: TaskboardIdentity, taskId: string, input: TaskBoardTaskPatchInput): Promise<TaskBoardTask>;
  moveTask(identity: TaskboardIdentity, taskId: string, input: TaskBoardTaskMoveInput): Promise<TaskBoardTask>;
  archiveTask(identity: TaskboardIdentity, taskId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardTask>;
  restoreTask(identity: TaskboardIdentity, taskId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardTask>;
  deleteTask(identity: TaskboardIdentity, taskId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardTask>;

  listComments(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardComment[]>;
  searchComments(
    identity: TaskboardIdentity,
    taskId: string,
    filter?: TaskboardPageFilter,
  ): Promise<TaskboardPage<TaskBoardComment>>;
  createComment(identity: TaskboardIdentity, taskId: string, input: TaskBoardCommentCreateInput): Promise<TaskBoardComment>;
  updateComment(identity: TaskboardIdentity, commentId: string, input: TaskBoardCommentPatchInput): Promise<TaskBoardComment>;
  deleteComment(identity: TaskboardIdentity, commentId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardComment>;

  listMembers?(identity: TaskboardIdentity, boardId: string): Promise<TaskBoardMember[]>;
  upsertMember?(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardMemberPatchInput,
  ): Promise<TaskBoardMember>;
  removeMember?(identity: TaskboardIdentity, boardId: string, userId: string): Promise<void>;
  createIntegrationBatch?(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardIntegrationBatchCreateInput,
    source?: 'scheduled_policy' | 'on_ready_policy' | 'manual_batch',
  ): Promise<TaskBoardTask>;
  cancelIntegrationTask?(
    identity: TaskboardIdentity,
    taskId: string,
    input: { expectedVersion: number; reason?: string },
  ): Promise<TaskBoardTask>;
  listIntegrationSources?(
    identity: TaskboardIdentity,
    integrationTaskId: string,
  ): Promise<TaskBoardIntegrationSource[]>;
  getIntegrationCandidate?(
    identity: TaskboardIdentity,
    integrationTaskId: string,
    options?: { includeHistory?: boolean; page?: number; pageSize?: number },
  ): Promise<TaskboardIntegrationCandidateView>;
  resumeBlockedTask?(
    identity: TaskboardIdentity,
    taskId: string,
    input: { expectedVersion: number; decision: string; sourceIds?: string[] },
  ): Promise<TaskBoardTask>;
  getExecutionContextV2?(
    identity: TaskboardIdentity,
    taskId: string,
    input?: TaskBoardExecutionContextInput,
  ): Promise<TaskBoardExecutionContextResponse>;
  createExecutionCommentV2?(
    identity: TaskboardIdentity,
    runId: string,
    body: string,
  ): Promise<TaskBoardComment>;
  attachExecutionPullRequestV2?(
    identity: TaskboardIdentity,
    runId: string,
    providerPullRequestId: string,
  ): Promise<TaskBoardTask>;
  recordReviewedExecutionSubjectV2?(
    identity: TaskboardIdentity,
    runId: string,
  ): Promise<TaskBoardTask>;
  inspectIntegrationSourceV2?(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
  ): Promise<TaskboardIntegrationSourceInspection>;
  mergeIntegrationSourceV2?(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
  ): Promise<TaskboardIntegrationMergeResult>;
  linkIntegrationRemediationV2?(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
    remediationTaskId: string,
  ): Promise<TaskBoardIntegrationSource>;
  reconcileMergeOperationsV2?(limit?: number): Promise<number>;
  resolveExecutionV2?(
    identity: TaskboardIdentity,
    runId: string,
    input: TaskBoardExecutionResolutionInput,
  ): Promise<TaskBoardTask>;
}

export class TaskboardNotFoundError extends Error {
  readonly code = 'TASKBOARD_NOT_FOUND';

  constructor(message = 'Resource not found') {
    super(message);
  }
}

export class TaskboardValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'TASKBOARD_VALIDATION_ERROR') {
    super(message);
    this.code = code;
  }
}

export class TaskboardPermissionError extends Error {
  readonly code = 'TASKBOARD_PERMISSION_DENIED';

  constructor(message = 'Taskboard permission denied') {
    super(message);
  }
}

export class TaskboardExecutionUnavailableError extends Error {
  readonly code = 'TASKBOARD_EXECUTION_UNAVAILABLE';

  constructor(message = 'Taskboard Agent execution unavailable') {
    super(message);
  }
}

export class TaskboardConflictError<T extends TaskBoard | TaskBoardTask | TaskBoardComment> extends Error {
  readonly code = 'TASKBOARD_VERSION_CONFLICT';
  readonly current: T;

  constructor(current: T) {
    super('Version conflict');
    this.current = current;
  }
}
