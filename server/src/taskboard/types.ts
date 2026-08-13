import type {
  TaskBoard,
  TaskBoardAttachment,
  TaskBoardComment,
  TaskBoardCommentCreateInput,
  TaskBoardCommentPatchInput,
  TaskBoardCreateInput,
  TaskBoardExecution,
  TaskBoardExecutionStartInput,
  TaskBoardExecutionStartResult,
  TaskBoardExecutionStatus,
  TaskBoardPatchInput,
  TaskBoardPriority,
  TaskBoardStatus,
  TaskBoardTask,
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

export interface TaskboardBoardSearchFilter {
  includeArchived?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface TaskboardTaskListFilter {
  includeArchived?: boolean;
  search?: string;
  statuses?: TaskBoardStatus[];
  priorities?: TaskBoardPriority[];
}

export interface TaskboardTaskSearchFilter extends TaskboardTaskListFilter {
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
  page?: number;
  pageSize?: number;
}

export interface TaskboardExpectedVersionInput {
  expectedVersion: number;
}

export interface TaskboardExecutionDispatchPayload {
  version: 1;
  session: RuntimeSessionRecord;
  run: UpsertRunInput;
}

export interface TaskboardExecutionClaimInput extends TaskBoardExecutionStartInput {
  executionId: string;
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
  boardOwnerUserId: string;
}

export interface TaskboardExecutionContext {
  identity: TaskboardIdentity;
  task: TaskBoardTask;
  boardPrompt: string;
  comments: TaskBoardComment[];
  execution: TaskBoardExecution;
}

export interface TaskboardExecutionCompletionInput {
  status: "succeeded" | "failed" | "cancelled";
  commentBody: string;
  attachments?: TaskBoardAttachment[];
  error?: string;
}

export interface TaskboardExecutionStore {
  listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]>;
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
    status: Extract<TaskBoardStatus, 'done' | 'todo'>,
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

export interface TaskboardExecutionService {
  listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]>;
  startExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardExecutionStartInput,
  ): Promise<TaskBoardExecutionStartResult>;
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

  listComments(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardComment[]>;
  createComment(identity: TaskboardIdentity, taskId: string, input: TaskBoardCommentCreateInput): Promise<TaskBoardComment>;
  updateComment(identity: TaskboardIdentity, commentId: string, input: TaskBoardCommentPatchInput): Promise<TaskBoardComment>;
  deleteComment(identity: TaskboardIdentity, commentId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardComment>;
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
