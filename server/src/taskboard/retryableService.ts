import type {
  TaskBoard,
  TaskBoardComment,
  TaskBoardCommentCreateInput,
  TaskBoardCreateInput,
  TaskBoardExecution,
  TaskBoardExecutionStartResult,
  TaskBoardPatchInput,
  TaskBoardTask,
  TaskBoardTaskCreateInput,
  TaskBoardTaskMoveInput,
  TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';
import type {
  TaskboardExecutionClaimInput,
  TaskboardExecutionCompletionInput,
  TaskboardExecutionContext,
  TaskboardExecutionDispatch,
  TaskboardExecutionReconcileCandidate,
  TaskboardExecutionStore,
  TaskboardExpectedVersionInput,
  TaskboardIdentity,
  TaskboardService,
  TaskboardTaskListFilter,
} from './types.js';

export interface InitializableTaskboardService extends TaskboardService, TaskboardExecutionStore {
  init(): Promise<void>;
}

/**
 * 启动阶段初始化失败时保留服务对象；后续请求会重新尝试 init。
 * 并发请求共享同一个初始化 Promise，避免数据库恢复瞬间重复执行 DDL。
 */
export class RetryableTaskboardService implements TaskboardService, TaskboardExecutionStore {
  private ready = false;
  private initializing: Promise<void> | undefined;

  constructor(private readonly target: InitializableTaskboardService) {}

  async init(): Promise<void> {
    if (this.ready) return;
    if (!this.initializing) {
      this.initializing = this.target.init()
        .then(() => {
          this.ready = true;
        })
        .finally(() => {
          this.initializing = undefined;
        });
    }
    await this.initializing;
  }

  private async service(): Promise<TaskboardService> {
    await this.init();
    return this.target;
  }

  async listBoards(identity: TaskboardIdentity, includeArchived?: boolean): Promise<TaskBoard[]> {
    return (await this.service()).listBoards(identity, includeArchived);
  }

  async createBoard(identity: TaskboardIdentity, input: TaskBoardCreateInput): Promise<TaskBoard> {
    return (await this.service()).createBoard(identity, input);
  }

  async updateBoard(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardPatchInput,
  ): Promise<TaskBoard> {
    return (await this.service()).updateBoard(identity, boardId, input);
  }

  async archiveBoard(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoard> {
    return (await this.service()).archiveBoard(identity, boardId, input);
  }

  async restoreBoard(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoard> {
    return (await this.service()).restoreBoard(identity, boardId, input);
  }

  async listTasks(
    identity: TaskboardIdentity,
    boardId: string,
    filter?: TaskboardTaskListFilter,
  ): Promise<TaskBoardTask[]> {
    return (await this.service()).listTasks(identity, boardId, filter);
  }

  async createTask(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardTaskCreateInput,
  ): Promise<TaskBoardTask> {
    return (await this.service()).createTask(identity, boardId, input);
  }

  async getTask(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardTask> {
    return (await this.service()).getTask(identity, taskId);
  }

  async updateTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardTaskPatchInput,
  ): Promise<TaskBoardTask> {
    return (await this.service()).updateTask(identity, taskId, input);
  }

  async moveTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardTaskMoveInput,
  ): Promise<TaskBoardTask> {
    return (await this.service()).moveTask(identity, taskId, input);
  }

  async archiveTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoardTask> {
    return (await this.service()).archiveTask(identity, taskId, input);
  }

  async restoreTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoardTask> {
    return (await this.service()).restoreTask(identity, taskId, input);
  }

  async listComments(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardComment[]> {
    return (await this.service()).listComments(identity, taskId);
  }

  async createComment(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardCommentCreateInput,
  ): Promise<TaskBoardComment> {
    return (await this.service()).createComment(identity, taskId, input);
  }

  async listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]> {
    await this.init();
    return this.target.listExecutions(identity, taskId);
  }

  async claimExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExecutionClaimInput,
  ): Promise<TaskBoardExecutionStartResult> {
    await this.init();
    return this.target.claimExecution(identity, taskId, input);
  }

  async getExecutionContextByRunId(runId: string): Promise<TaskboardExecutionContext | null> {
    await this.init();
    return this.target.getExecutionContextByRunId(runId);
  }

  async claimExecutionDispatch(
    runId: string | undefined,
    leaseId: string,
  ): Promise<TaskboardExecutionDispatch | null> {
    await this.init();
    return this.target.claimExecutionDispatch(runId, leaseId);
  }

  async markExecutionDispatchSucceeded(runId: string, leaseId: string): Promise<boolean> {
    await this.init();
    return this.target.markExecutionDispatchSucceeded(runId, leaseId);
  }

  async retryExecutionDispatch(
    runId: string,
    leaseId: string,
    error: string,
    delayMs: number,
  ): Promise<boolean> {
    await this.init();
    return this.target.retryExecutionDispatch(runId, leaseId, error, delayMs);
  }

  async claimExecutionReconcileCandidates(
    staleBefore: Date,
    limit: number,
    leaseId: string,
  ): Promise<TaskboardExecutionReconcileCandidate[]> {
    await this.init();
    return this.target.claimExecutionReconcileCandidates(staleBefore, limit, leaseId);
  }

  async setExecutionStatus(
    runId: string,
    status: "running" | "waiting_user" | "waiting_approval",
  ): Promise<TaskBoardExecution | null> {
    await this.init();
    return this.target.setExecutionStatus(runId, status);
  }

  async setExecutionStatusFromReconcile(
    runId: string,
    status: "running" | "waiting_user" | "waiting_approval",
    leaseId: string,
  ): Promise<TaskBoardExecution | null> {
    await this.init();
    return this.target.setExecutionStatusFromReconcile(runId, status, leaseId);
  }

  async completeExecution(
    runId: string,
    input: TaskboardExecutionCompletionInput,
  ): Promise<TaskBoardExecutionStartResult | null> {
    await this.init();
    return this.target.completeExecution(runId, input);
  }

  async completeExecutionFromReconcile(
    runId: string,
    input: TaskboardExecutionCompletionInput,
    leaseId: string,
  ): Promise<TaskBoardExecutionStartResult | null> {
    await this.init();
    return this.target.completeExecutionFromReconcile(runId, input, leaseId);
  }
}
