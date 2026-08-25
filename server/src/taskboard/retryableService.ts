import type {
  TaskBoard,
  TaskBoardComment,
  TaskBoardCommentCreateInput,
  TaskBoardCommentPatchInput,
  TaskBoardCreateInput,
  TaskBoardExecution,
  TaskBoardExecutionContextInput,
  TaskBoardExecutionContextResponse,
  TaskBoardExecutionFinishInput,
  TaskBoardExecutionStartResult,
  TaskBoardIntegrationBatchCreateInput,
  TaskBoardIntegrationSource,
  TaskBoardMember,
  TaskBoardMemberPatchInput,
  TaskBoardPatchInput,
  TaskBoardTask,
  TaskBoardTaskCreateInput,
  TaskBoardTaskMoveInput,
  TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';
import type {
  TaskboardBoardSearchFilter,
  TaskboardContinuationContext,
  TaskboardContinuationDispatch,
  TaskboardContinuationDispatchPayload,
  TaskboardContinuationReconcileCandidate,
  TaskboardExecutionClaimInput,
  TaskboardExecutionCompletionInput,
  TaskboardExecutionContext,
  TaskboardExecutionDispatch,
  TaskboardExecutionModelContext,
  TaskboardExecutionReconcileCandidate,
  TaskboardExecutionStore,
  TaskboardExpectedVersionInput,
  TaskboardIdentity,
  TaskboardIntegrationDispatchCandidate,
  TaskboardIntegrationMergeResult,
  TaskboardIntegrationSourceInspection,
  TaskboardPage,
  TaskboardPageFilter,
  TaskboardService,
  TaskboardTaskListFilter,
  TaskboardTaskSearchFilter,
} from './types.js';
import type { RepositoryProvider } from './repositoryProvider.js';
import type { ExecutionPullRequestInspection } from './deliveryPullRequests.js';

export interface InitializableTaskboardService extends TaskboardService, TaskboardExecutionStore {
  init(): Promise<void>;
  setRepositoryProvider?(provider: RepositoryProvider): void;
}

/**
 * 启动阶段初始化失败时保留服务对象；后续请求会重新尝试 init。
 * 并发请求共享同一个初始化 Promise，避免数据库恢复瞬间重复执行 DDL。
 */
export class RetryableTaskboardService implements TaskboardService, TaskboardExecutionStore {
  private ready = false;
  private initializing: Promise<void> | undefined;

  constructor(
    private readonly target: InitializableTaskboardService,
    private readonly options: { onReady?: () => void | Promise<void> } = {},
  ) {}

  async init(): Promise<void> {
    if (this.ready) return;
    if (!this.initializing) {
      this.initializing = this.target.init()
        .then(async () => {
          await this.options.onReady?.();
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

  async searchBoards(
    identity: TaskboardIdentity,
    filter?: TaskboardBoardSearchFilter,
  ): Promise<TaskboardPage<TaskBoard>> {
    return (await this.service()).searchBoards(identity, filter);
  }

  async getBoard(identity: TaskboardIdentity, boardId: string): Promise<TaskBoard> {
    return (await this.service()).getBoard(identity, boardId);
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

  async searchTasks(
    identity: TaskboardIdentity,
    filter?: TaskboardTaskSearchFilter,
  ): Promise<TaskboardPage<TaskBoardTask>> {
    return (await this.service()).searchTasks(identity, filter);
  }

  async createTask(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardTaskCreateInput,
  ): Promise<TaskBoardTask> {
    return (await this.service()).createTask(identity, boardId, input);
  }

  async createTaskWithResult(identity: TaskboardIdentity, boardId: string, input: TaskBoardTaskCreateInput,
    requestDigest?: string) {
    return (await this.service()).createTaskWithResult(identity, boardId, input, requestDigest);
  }

  async completeTaskCreation(identity: TaskboardIdentity, taskId: string, claimToken: string) {
    return (await this.service()).completeTaskCreation(identity, taskId, claimToken);
  }

  async releaseTaskCreation(identity: TaskboardIdentity, taskId: string, claimToken: string) {
    return (await this.service()).releaseTaskCreation(identity, taskId, claimToken);
  }

  async getTask(identity: TaskboardIdentity, taskId: string, creationClaimToken?: string): Promise<TaskBoardTask> {
    return (await this.service()).getTask(identity, taskId, creationClaimToken);
  }

  async isTaskWatched(identity: TaskboardIdentity, taskId: string): Promise<boolean> {
    const service = await this.service();
    if (!service.isTaskWatched) return false;
    return service.isTaskWatched(identity, taskId);
  }

  async setTaskWatched(identity: TaskboardIdentity, taskId: string, watched: boolean): Promise<boolean> {
    const service = await this.service();
    if (!service.setTaskWatched) throw new Error('Task watch unavailable');
    return service.setTaskWatched(identity, taskId, watched);
  }

  async updateTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardTaskPatchInput,
    creationClaimToken?: string,
  ): Promise<TaskBoardTask> {
    return (await this.service()).updateTask(identity, taskId, input, creationClaimToken);
  }

  async applyGeneratedTaskTitle(
    identity: TaskboardIdentity,
    taskId: string,
    title: string,
  ): Promise<TaskBoardTask> {
    const service = await this.service();
    if (service.applyGeneratedTaskTitle) {
      return service.applyGeneratedTaskTitle(identity, taskId, title);
    }
    const task = await service.getTask(identity, taskId);
    return service.updateTask(identity, taskId, { title, expectedVersion: task.version });
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

  async deleteTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoardTask> {
    return (await this.service()).deleteTask(identity, taskId, input);
  }

  async rollbackTaskCreation(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoardTask> {
    return (await this.service()).rollbackTaskCreation(identity, taskId, input);
  }

  async listComments(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardComment[]> {
    return (await this.service()).listComments(identity, taskId);
  }

  async searchComments(
    identity: TaskboardIdentity,
    taskId: string,
    filter?: TaskboardPageFilter,
  ): Promise<TaskboardPage<TaskBoardComment>> {
    return (await this.service()).searchComments(identity, taskId, filter);
  }

  async createComment(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardCommentCreateInput,
  ): Promise<TaskBoardComment> {
    return (await this.service()).createComment(identity, taskId, input);
  }

  async updateComment(
    identity: TaskboardIdentity,
    commentId: string,
    input: TaskBoardCommentPatchInput,
  ): Promise<TaskBoardComment> {
    return (await this.service()).updateComment(identity, commentId, input);
  }

  async deleteComment(
    identity: TaskboardIdentity,
    commentId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoardComment> {
    return (await this.service()).deleteComment(identity, commentId, input);
  }

  async listMembers(identity: TaskboardIdentity, boardId: string): Promise<TaskBoardMember[]> {
    const service = await this.service();
    if (!service.listMembers) return [];
    return service.listMembers(identity, boardId);
  }

  async upsertMember(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardMemberPatchInput,
  ): Promise<TaskBoardMember> {
    const service = await this.service();
    if (!service.upsertMember) throw new Error('Taskboard member management unavailable');
    return service.upsertMember(identity, boardId, input);
  }

  async removeMember(identity: TaskboardIdentity, boardId: string, userId: string): Promise<void> {
    const service = await this.service();
    if (!service.removeMember) throw new Error('Taskboard member management unavailable');
    return service.removeMember(identity, boardId, userId);
  }

  async getBoardCiPolicyDiscovery(identity: TaskboardIdentity, boardId: string) {
    const service = await this.service();
    if (!service.getBoardCiPolicyDiscovery) throw new Error('Taskboard CI policy discovery unavailable');
    return service.getBoardCiPolicyDiscovery(identity, boardId);
  }

  async createIntegrationBatch(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardIntegrationBatchCreateInput,
    source?: 'scheduled_policy' | 'on_ready_policy' | 'manual_batch',
  ): Promise<TaskBoardTask> {
    const service = await this.service();
    if (!service.createIntegrationBatch) throw new Error('Taskboard integration unavailable');
    return service.createIntegrationBatch(identity, boardId, input, source);
  }

  async cancelIntegrationTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: { expectedVersion: number; reason?: string },
  ): Promise<TaskBoardTask> {
    await this.init();
    if (!this.target.cancelIntegrationTask) throw new Error('Taskboard integration service unavailable');
    return this.target.cancelIntegrationTask(identity, taskId, input);
  }

  async getIntegrationCandidate(
    identity: TaskboardIdentity,
    integrationTaskId: string,
    options?: { includeHistory?: boolean; page?: number; pageSize?: number },
  ) {
    const service = await this.service();
    if (!service.getIntegrationCandidate) throw new Error('Taskboard Integration v3 candidate read unavailable');
    return service.getIntegrationCandidate(identity, integrationTaskId, options);
  }

  async resumeBlockedTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: { expectedVersion: number; decision: string; sourceIds?: string[] },
  ): Promise<TaskBoardTask> {
    const service = await this.service();
    if (!service.resumeBlockedTask) throw new Error('Taskboard resume service unavailable');
    return service.resumeBlockedTask(identity, taskId, input);
  }

  async listIntegrationSources(
    identity: TaskboardIdentity,
    integrationTaskId: string,
  ): Promise<TaskBoardIntegrationSource[]> {
    const service = await this.service();
    if (!service.listIntegrationSources) return [];
    return service.listIntegrationSources(identity, integrationTaskId);
  }

  async getExecutionContextV2(
    identity: TaskboardIdentity,
    taskId: string,
    input?: TaskBoardExecutionContextInput,
  ): Promise<TaskBoardExecutionContextResponse> {
    const service = await this.service();
    if (!service.getExecutionContextV2) throw new Error('Taskboard execution context unavailable');
    return service.getExecutionContextV2(identity, taskId, input);
  }

  setRepositoryProvider(provider: RepositoryProvider): void {
    this.target.setRepositoryProvider?.(provider);
  }

  async attachExecutionPullRequestV2(
    identity: TaskboardIdentity,
    runId: string,
    providerPullRequestId: string,
  ): Promise<TaskBoardTask> {
    await this.init();
    if (!this.target.attachExecutionPullRequestV2) throw new Error('Taskboard repository provider unavailable');
    return this.target.attachExecutionPullRequestV2(identity, runId, providerPullRequestId);
  }

  async inspectExecutionPullRequestV2(
    identity: TaskboardIdentity,
    runId: string,
  ): Promise<ExecutionPullRequestInspection> {
    await this.init();
    if (!this.target.inspectExecutionPullRequestV2) throw new Error('Taskboard repository provider unavailable');
    return this.target.inspectExecutionPullRequestV2(identity, runId);
  }

  async readExecutionPullRequestJobLogV2(
    identity: TaskboardIdentity,
    runId: string,
    inspectionId: string,
    providerJobId: string,
  ): Promise<{ inspectionId: string; providerJobId: string; log: string }> {
    await this.init();
    if (!this.target.readExecutionPullRequestJobLogV2) throw new Error('Taskboard repository provider unavailable');
    return this.target.readExecutionPullRequestJobLogV2(identity, runId, inspectionId, providerJobId);
  }

  async recordReviewedExecutionSubjectV2(
    identity: TaskboardIdentity,
    runId: string,
  ): Promise<TaskBoardTask> {
    await this.init();
    if (!this.target.recordReviewedExecutionSubjectV2) throw new Error('Taskboard repository provider unavailable');
    return this.target.recordReviewedExecutionSubjectV2(identity, runId);
  }

  async inspectIntegrationSourceV2(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
  ): Promise<TaskboardIntegrationSourceInspection> {
    await this.init();
    if (!this.target.inspectIntegrationSourceV2) throw new Error('Taskboard integration provider unavailable');
    return this.target.inspectIntegrationSourceV2(identity, runId, sourceId);
  }

  async readIntegrationSourceJobLogV2(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
    inspectionId: string,
    providerJobId: string,
  ): Promise<{ inspectionId: string; providerJobId: string; log: string }> {
    await this.init();
    if (!this.target.readIntegrationSourceJobLogV2) throw new Error('Taskboard integration provider unavailable');
    return this.target.readIntegrationSourceJobLogV2(identity, runId, sourceId, inspectionId, providerJobId);
  }

  async mergeIntegrationSourceV2(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
  ): Promise<TaskboardIntegrationMergeResult> {
    await this.init();
    if (!this.target.mergeIntegrationSourceV2) throw new Error('Taskboard integration provider unavailable');
    return this.target.mergeIntegrationSourceV2(identity, runId, sourceId);
  }

  async linkIntegrationRemediationV2(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
    remediationTaskId: string,
  ) {
    await this.init();
    if (!this.target.linkIntegrationRemediationV2) throw new Error('Taskboard integration provider unavailable');
    return this.target.linkIntegrationRemediationV2(identity, runId, sourceId, remediationTaskId);
  }

  async reconcileMergeOperationsV2(limit?: number): Promise<number> {
    await this.init();
    return this.target.reconcileMergeOperationsV2?.(limit) ?? 0;
  }

  async claimIntegrationDispatchCandidatesV2(limit?: number): Promise<TaskboardIntegrationDispatchCandidate[]> {
    await this.init();
    return this.target.claimIntegrationDispatchCandidatesV2?.(limit) ?? [];
  }

  async finishExecutionV2(
    identity: TaskboardIdentity,
    runId: string,
    input: TaskBoardExecutionFinishInput,
  ): Promise<TaskBoardTask> {
    const service = await this.service();
    if (!service.finishExecutionV2) throw new Error('Taskboard execution finish unavailable');
    return service.finishExecutionV2(identity, runId, input);
  }

  async listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]> {
    await this.init();
    return this.target.listExecutions(identity, taskId);
  }

  async searchExecutions(
    identity: TaskboardIdentity,
    taskId: string,
    filter?: TaskboardPageFilter,
  ): Promise<TaskboardPage<TaskBoardExecution>> {
    await this.init();
    return this.target.searchExecutions(identity, taskId, filter);
  }

  async getExecutionModelContext(
    identity: TaskboardIdentity,
    taskId: string,
  ): Promise<TaskboardExecutionModelContext> {
    await this.init();
    return this.target.getExecutionModelContext(identity, taskId);
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

  async getContinuationContext(
    identity: TaskboardIdentity,
    taskId: string,
    commentId: string,
  ): Promise<TaskboardContinuationContext> {
    await this.init();
    return this.target.getContinuationContext(identity, taskId, commentId);
  }

  async enqueueContinuation(
    taskId: string,
    commentIds: string[],
    runId: string,
    commentId: string,
    payload: TaskboardContinuationDispatchPayload,
  ): Promise<boolean> {
    await this.init();
    return this.target.enqueueContinuation(taskId, commentIds, runId, commentId, payload);
  }

  async claimContinuationDispatch(
    runId: string | undefined,
    leaseId: string,
  ): Promise<TaskboardContinuationDispatch | null> {
    await this.init();
    return this.target.claimContinuationDispatch(runId, leaseId);
  }

  async markContinuationDispatchSucceeded(runId: string, leaseId: string): Promise<boolean> {
    await this.init();
    return this.target.markContinuationDispatchSucceeded(runId, leaseId);
  }

  async retryContinuationDispatch(
    runId: string,
    leaseId: string,
    error: string,
    delayMs: number,
  ): Promise<boolean> {
    await this.init();
    return this.target.retryContinuationDispatch(runId, leaseId, error, delayMs);
  }

  async claimContinuationReconcileCandidates(
    staleBefore: Date,
    limit: number,
    leaseId: string,
  ): Promise<TaskboardContinuationReconcileCandidate[]> {
    await this.init();
    return this.target.claimContinuationReconcileCandidates(staleBefore, limit, leaseId);
  }

  async releaseContinuationReconcile(runId: string, leaseId: string): Promise<boolean> {
    await this.init();
    return this.target.releaseContinuationReconcile(runId, leaseId);
  }

  async finishContinuation(runId: string, leaseId?: string): Promise<boolean> {
    await this.init();
    return this.target.finishContinuation(runId, leaseId);
  }

  async markContinuationRunning(
    taskId: string,
    runId: string,
    reconcileLeaseId?: string,
  ): Promise<TaskBoardTask | null> {
    await this.init();
    return this.target.markContinuationRunning(taskId, runId, reconcileLeaseId);
  }

  async completeContinuation(
    taskId: string,
    runId: string,
    input: TaskboardExecutionCompletionInput,
  ): Promise<TaskBoardTask | null> {
    await this.init();
    return this.target.completeContinuation(taskId, runId, input);
  }

  async getExecutionContextBySessionId(sessionId: string): Promise<TaskboardExecutionContext | null> {
    await this.init();
    return this.target.getExecutionContextBySessionId(sessionId);
  }

  async updateTaskBranchFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    branch: string | null,
  ): Promise<TaskBoardTask> {
    await this.init();
    return this.target.updateTaskBranchFromExecution(identity, runId, branch);
  }

  async createTaskFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    input: TaskBoardTaskCreateInput,
  ): Promise<TaskBoardTask> {
    await this.init();
    return this.target.createTaskFromExecution(identity, runId, input);
  }

  async createTaskFromExecutionWithResult(identity: TaskboardIdentity, runId: string, input: TaskBoardTaskCreateInput,
    requestDigest?: string) {
    await this.init();
    return this.target.createTaskFromExecutionWithResult(identity, runId, input, requestDigest);
  }

  async moveTaskFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    status: Extract<TaskBoardTask['status'], 'ready_to_merge' | 'todo' | 'blocked'>,
  ): Promise<TaskBoardTask> {
    await this.init();
    return this.target.moveTaskFromExecution(identity, runId, status);
  }

  async claimExecutionDispatch(
    runId: string | undefined,
    leaseId: string,
  ): Promise<TaskboardExecutionDispatch | null> {
    await this.init();
    return this.target.claimExecutionDispatch(runId, leaseId);
  }

  async runExecutionDispatchGate(runId: string, leaseId: string, operation: () => Promise<void>): Promise<boolean> {
    await this.init();
    return this.target.runExecutionDispatchGate(runId, leaseId, operation);
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
