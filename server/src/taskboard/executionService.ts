import { randomUUID } from 'node:crypto';

import type {
  TaskBoardExecution,
  TaskBoardExecutionStartInput,
  TaskBoardExecutionStartResult,
} from '../../../shared/src/types/taskboard.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { resolveExecutionTarget, type ExecutionConfig } from '../runtime/executionConfig.js';
import { RunCreateConflictError, type RunRecord, type RunStore } from '../runtime/runStore.js';
import type { RuntimeScheduler } from '../runtime/scheduler.js';
import {
  createRuntimeSessionRecord,
  type SessionCatalog,
} from '../runtime/sessionCatalog.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import {
  extractAgentAttachments,
  extractContinuationAttachments,
  reconcileTerminalContinuation,
  stripFileMarkers,
} from './continuationCompletion.js';
import {
  dispatchTaskboardContinuation,
  reconcileTaskboardContinuation,
} from './continuationCoordinator.js';
import { reuseTaskboardSession } from './executionSession.js';
import { buildExecutionPrompt, formatTaskboardComment } from './executionPrompt.js';
export { executionWritebackInstructions } from './executionPrompt.js';
import {
  writeTaskboardSessionTitle,
  type TaskboardSessionTitleUpdate,
  type TaskboardSessionTitleWriter,
} from './sessionTitle.js';
import {
  TaskboardExecutionUnavailableError,
  TaskboardPermissionError,
  TaskboardValidationError,
} from './types.js';
export { createTaskboardRuntimeOptions } from './runtimeOptions.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionDispatch,
  TaskboardExecutionReconcileCandidate,
  TaskboardExecutionService,
  TaskboardExecutionStore,
  TaskboardIdentity,
  TaskboardPage,
  TaskboardPageFilter,
} from './types.js';

interface DefaultModelResolution {
  ref: string;
}

const RECONCILIATION_GRACE_MS = 30_000;

class InvalidTaskboardDispatchPayloadError extends Error {}

export interface TaskboardExecutionCoordinatorOptions {
  store: TaskboardExecutionStore;
  scheduler: Pick<RuntimeScheduler, 'enqueue' | 'enqueueCreateOnly'>;
  runStore: Pick<RunStore, 'get'>;
  sessionCatalog: SessionCatalog;
  eventStore: EventStore;
  agentCwd: string;
  executionConfig: ExecutionConfig;
  resolveDefaultModel: (tenantId?: string) => DefaultModelResolution | null;
  /** 按 ref 解析显式模型；解析失败时拒绝执行，避免静默使用错误模型。 */
  resolveModel?: (ref: string, tenantId?: string) => { ref: string } | null;
  /** 解析看板创建者的当前账号上下文；组织看板仍以创建者身份运行。 */
  resolveOwnerIdentity?: (userId: string) => TaskboardIdentity | undefined;
  /** 解析任务所有者的当前展示名，用于覆盖历史评论中存量账号名。 */
  resolveUserDisplayName?: (userId: string) => string | undefined;
  /** 执行提示词时间戳时区，默认 Asia/Shanghai。 */
  timezone?: string;
  /** 任务会话标题写入器；测试可替换，生产默认写 SessionMeta.generatedTitle。 */
  writeSessionTitle?: TaskboardSessionTitleWriter;
  /** 标题落盘后的缓存或实时事件通知，不得影响 durable dispatch。 */
  onSessionTitleUpdated?: (update: TaskboardSessionTitleUpdate) => void | Promise<void>;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export class TaskboardExecutionCoordinator implements TaskboardExecutionService {
  private reconciliation: Promise<void> | undefined;
  private reconciliationStopped = false;

  constructor(private readonly options: TaskboardExecutionCoordinatorOptions) {}

  wakeReconciliation(): void {
    if (this.reconciliationStopped || this.reconciliation) return;
    this.reconciliation = this.reconcile()
      .catch((error) => {
        this.options.logger?.warn(
          `Taskboard reconciliation cycle failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.reconciliation = undefined;
      });
  }

  async stop(): Promise<void> {
    this.reconciliationStopped = true;
    await this.reconciliation;
  }

  listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]> {
    return this.options.store.listExecutions(identity, taskId);
  }

  searchExecutions(
    identity: TaskboardIdentity,
    taskId: string,
    filter?: TaskboardPageFilter,
  ): Promise<TaskboardPage<TaskBoardExecution>> {
    return this.options.store.searchExecutions(identity, taskId, filter);
  }

  startExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardExecutionStartInput,
  ): Promise<TaskBoardExecutionStartResult> {
    return this.startExecutionInternal(identity, taskId, input);
  }

  startDirectExecution(
    identity: TaskboardIdentity,
    taskId: string,
    expectedVersion: number,
  ): Promise<TaskBoardExecutionStartResult> {
    return this.startExecutionInternal(identity, taskId, { expectedVersion }, {
      allowWorkFromCurrentStatus: true,
      executionId: `direct-${taskId}`,
    });
  }

  async continueExecution(
    identity: TaskboardIdentity, taskId: string, commentId: string,
  ): Promise<TaskBoardExecutionStartResult> {
    const context = await this.options.store.getContinuationContext(identity, taskId, commentId);
    const pendingCommentIds = context.pendingComments.map((comment) => comment.id);
    if (context.continuationExecution) {
      return { task: context.task, execution: context.continuationExecution };
    }
    if (context.continuationRunId
      && context.latestExecution?.runId === context.continuationRunId) {
      return { task: context.task, execution: context.latestExecution };
    }
    const existingContinuation = context.continuationRunId
      ? await this.options.runStore.get(context.continuationRunId)
      : null;
    if (existingContinuation && isTerminalRun(existingContinuation)) {
      if (typeof existingContinuation.metadata?.steeringTargetRunId === 'string') {
        if (existingContinuation.status === 'completed'
          && existingContinuation.metadata?.steeringState === 'applied') {
          await this.options.store.finishContinuation(existingContinuation.runId);
        } else {
          const reason = existingContinuation.statusReason
            || `Runtime steering source 状态：${existingContinuation.status}`;
          await this.options.store.completeContinuation(taskId, existingContinuation.runId, {
            status: existingContinuation.status === 'cancelled' ? 'cancelled' : 'failed',
            error: reason,
            commentBody: limitComment(
              `Agent 继续执行${existingContinuation.status === 'cancelled' ? '已取消' : '失败'}\n\n${reason}`,
            ),
          });
        }
        const execution = context.activeExecution ?? context.latestExecution;
        if (!execution) throw new TaskboardExecutionUnavailableError('评论插话目标执行记录缺失');
        return { task: context.task, execution };
      }
      if (!context.latestExecution) {
        throw new TaskboardExecutionUnavailableError('评论续跑记录存在，但任务执行记录缺失');
      }
      const reconciledTask = await reconcileTerminalContinuation({
        store: this.options.store,
        eventStore: this.options.eventStore,
        taskId,
        run: existingContinuation,
        agentCwd: this.options.agentCwd,
      });
      return { task: reconciledTask ?? context.task, execution: context.latestExecution };
    }
    if (!context.activeExecution && !context.continuationRunId && !context.hasActiveContinuation) {
      try {
        return await this.startExecutionInternal(
          identity,
          taskId,
          { expectedVersion: context.task.version },
          { allowWorkFromCurrentStatus: true, executionId: commentId },
        );
      } catch (error) {
        if (!(error instanceof TaskboardValidationError) || error.code !== 'TASKBOARD_EXECUTION_ACTIVE') throw error;
        return this.continueExecution(identity, taskId, commentId);
      }
    }

    const targetExecution = context.activeExecution ?? context.latestExecution;
    if (!targetExecution) throw new TaskboardExecutionUnavailableError('任务没有可复用的执行会话');
    const launch = await this.resolveLaunch(identity, taskId);
    const session = await reuseTaskboardSession({
      sessionCatalog: this.options.sessionCatalog,
      agentCwd: this.options.agentCwd,
      sessionId: targetExecution.sessionId,
      executionIdentity: launch.executionIdentity,
      modelRef: launch.model.ref,
      executionTarget: launch.executionTarget,
    });
    const runId = context.continuationRunId ?? `taskboard-comment-${commentId}`;
    const run = {
      runId,
      sessionId: session.sessionId,
      userId: launch.executionIdentity.ownerUserId,
      tenantId: launch.executionIdentity.tenantId,
      model: launch.model.ref,
      channel: 'web',
      idempotencyKey: `taskboard-comment:${commentId}`,
      executionTarget: launch.executionTarget,
      workspaceId: session.workspaceId,
      metadata: {
        taskboardContinuation: true,
        taskboardTaskId: taskId,
        taskboardCommentId: commentId,
        outputTransactionMode: 'terminal_buffered',
        cwd: session.cwd,
        transcriptPath: session.transcriptPath,
        wakeMessage: {
          channel: 'web',
          chatId: session.sessionId,
          content: `任务看板新增评论：\n\n${context.pendingComments.map((comment) => formatTaskboardComment(
            comment,
            this.options.timezone,
            this.options.resolveUserDisplayName?.(comment.authorId),
          )).join('\n\n')}`,
          senderId: launch.executionIdentity.ownerUserId,
          senderName: launch.executionIdentity.username,
          metadata: {
            taskboardContinuation: true,
            taskboardTaskId: taskId,
            taskboardCommentId: commentId,
          },
        },
      },
    };
    const queued = await this.options.store.enqueueContinuation(
      taskId,
      pendingCommentIds,
      runId,
      commentId,
      { version: 1, session, run },
    );
    if (!queued) throw new TaskboardExecutionUnavailableError('评论已由另一条续跑请求处理');
    const nextTask = await this.options.store.markContinuationRunning(taskId, runId) ?? context.task;
    await dispatchTaskboardContinuation(this.options, runId);
    return { task: nextTask, execution: targetExecution };
  }

  private async startExecutionInternal(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardExecutionStartInput,
    options: { allowWorkFromCurrentStatus?: boolean; executionId?: string } = {},
  ): Promise<TaskBoardExecutionStartResult> {
    const launch = await this.resolveLaunch(identity, taskId);
    const executions = await this.options.store.listExecutions(identity, taskId);
    const executionId = options.executionId ?? randomUUID();
    const sessionId = executions[0]?.sessionId ?? `taskboard-${randomUUID()}`;
    const session = await reuseTaskboardSession({
      sessionCatalog: this.options.sessionCatalog,
      agentCwd: this.options.agentCwd,
      sessionId,
      executionIdentity: launch.executionIdentity,
      modelRef: launch.model.ref,
      executionTarget: launch.executionTarget,
    });
    const runId = `taskboard-execution-${executionId}`;
    const run = {
      runId,
      sessionId,
      userId: launch.executionIdentity.ownerUserId,
      tenantId: launch.executionIdentity.tenantId,
      model: launch.model.ref,
      channel: 'web',
      idempotencyKey: `taskboard-execution:${executionId}`,
      executionTarget: launch.executionTarget,
      workspaceId: session.workspaceId,
      metadata: {
        taskboardExecution: true,
        taskboardExecutionId: executionId,
        taskboardTaskId: taskId,
        outputTransactionMode: 'terminal_buffered',
        cwd: session.cwd,
        transcriptPath: session.transcriptPath,
        wakeMessage: {
          channel: 'web',
          chatId: sessionId,
          content: '正在读取任务看板中的最新任务与评论。',
          senderId: launch.executionIdentity.ownerUserId,
          senderName: launch.executionIdentity.username,
          metadata: {
            taskboardExecution: true,
            taskboardExecutionId: executionId,
            taskboardTaskId: taskId,
          },
        },
      },
    };
    const claimed = await this.options.store.claimExecution(identity, taskId, {
      ...input,
      executionId,
      sessionId,
      runId,
      ...(options.allowWorkFromCurrentStatus ? { allowWorkFromCurrentStatus: true } : {}),
      ...(launch.explicitModelRef ? { configuredModelRef: launch.explicitModelRef } : {}),
      executionOwnerUserId: launch.executionIdentity.ownerUserId,
      dispatch: { version: 1, session, run },
    });
    await this.dispatchExecution(runId);
    return claimed;
  }

  private async resolveLaunch(identity: TaskboardIdentity, taskId: string) {
    const modelContext = await this.options.store.getExecutionModelContext(identity, taskId);
    if (modelContext.boardOwnerUserId !== identity.ownerUserId) {
      throw new TaskboardPermissionError('Only the board owner may dispatch an Agent for this board');
    }
    const executionIdentity = identity;
    const explicitModelRef = modelContext.taskModel ?? modelContext.boardModel;
    const model = explicitModelRef
      ? this.options.resolveModel?.(explicitModelRef, executionIdentity.tenantId)
      : this.options.resolveDefaultModel(executionIdentity.tenantId);
    if (!model) {
      throw new TaskboardExecutionUnavailableError(
        explicitModelRef ? `指定模型不可用：${explicitModelRef}` : '当前组织没有可用的默认模型',
      );
    }
    const decision = resolveExecutionTarget({
      user: { role: executionIdentity.userRole, tenantId: executionIdentity.tenantId },
      config: this.options.executionConfig,
    });
    if (!decision.ok) throw new TaskboardExecutionUnavailableError(decision.reason);
    return { executionIdentity, explicitModelRef, model, executionTarget: decision.target };
  }

  async reconcile(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      const dispatched = await this.dispatchExecution();
      if (!dispatched) break;
    }
    for (let index = 0; index < 20; index += 1) {
      const dispatched = await dispatchTaskboardContinuation(this.options);
      if (!dispatched) break;
    }

    const staleBefore = new Date(Date.now() - RECONCILIATION_GRACE_MS);
    const candidates = await this.options.store.claimExecutionReconcileCandidates(
      staleBefore,
      100,
      randomUUID(),
    );
    for (const candidate of candidates) {
      try {
        const run = await this.options.runStore.get(candidate.runId);
        if (!run) {
          if (!candidate.dispatchStatus || candidate.dispatchStatus === 'dispatched') {
            const reason = candidate.dispatchStatus
              ? 'Runtime Run 不存在，已停止该次 Agent 执行'
              : '执行派发记录缺失，已停止该次 Agent 执行';
            await this.options.store.completeExecutionFromReconcile(candidate.runId, {
              status: 'failed',
              error: reason,
              commentBody: limitComment(`Agent 执行失败\n\n${reason}`),
            }, candidate.leaseId);
          }
          continue;
        }
        if (!matchesReconcileCandidate(run, candidate)) {
          const reason = 'Runtime Run 与任务看板 Execution 关联校验失败';
          await this.options.store.completeExecutionFromReconcile(candidate.runId, {
            status: 'failed',
            error: reason,
            commentBody: limitComment(`Agent 执行失败\n\n${reason}`),
          }, candidate.leaseId);
          continue;
        }
        await this.reconcileRunRecord(run, candidate);
      } catch (error) {
        this.options.logger?.warn(
          `Taskboard execution reconciliation failed: run=${candidate.runId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const continuationCandidates = await this.options.store.claimContinuationReconcileCandidates(
      staleBefore,
      100,
      randomUUID(),
    );
    for (const candidate of continuationCandidates) {
      try {
        await reconcileTaskboardContinuation(this.options, candidate);
      } catch (error) {
        this.options.logger?.warn(
          `Taskboard continuation reconciliation failed: run=${candidate.runId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async dispatchExecution(runId?: string): Promise<boolean> {
    const leaseId = randomUUID();
    let dispatch;
    try {
      dispatch = await this.options.store.claimExecutionDispatch(runId, leaseId);
    } catch (error) {
      this.options.logger?.warn(
        `Taskboard execution dispatch claim failed: run=${runId ?? 'next'} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (!dispatch) return false;

    try {
      const canonical = canonicalizeDispatchPayload(dispatch, this.options.agentCwd);
      await this.options.sessionCatalog.upsert(canonical.session);
      const titleUpdate = await (this.options.writeSessionTitle ?? writeTaskboardSessionTitle)({
        store: this.options.store,
        sessionId: canonical.session.sessionId,
        transcriptPath: canonical.session.transcriptPath,
      });
      if (titleUpdate) {
        try {
          await this.options.onSessionTitleUpdated?.(titleUpdate);
        } catch (error) {
          this.options.logger?.warn(
            `Taskboard session title notification failed: session=${titleUpdate.sessionId} error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const run = await this.options.scheduler.enqueueCreateOnly(canonical.run);
      assertDispatchedRun(run, dispatch, canonical.run);
      const marked = await this.options.store.markExecutionDispatchSucceeded(dispatch.runId, dispatch.leaseId);
      if (!marked) {
        this.options.logger?.warn(`Taskboard execution dispatch lease changed after enqueue: run=${dispatch.runId}`);
      }
      this.options.logger?.info(`Taskboard execution queued: run=${dispatch.runId}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof InvalidTaskboardDispatchPayloadError || error instanceof RunCreateConflictError) {
        try {
          await this.options.store.completeExecution(dispatch.runId, {
            status: 'failed',
            error: message,
            commentBody: limitComment(`Agent 执行失败\n\n${message}`),
          });
          this.options.logger?.warn(`Taskboard execution poison dispatch stopped: run=${dispatch.runId} error=${message}`);
          return true;
        } catch (finalizeError) {
          this.options.logger?.warn(
            `Taskboard poison dispatch finalization failed: run=${dispatch.runId} error=${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`,
          );
        }
      }
      const delayMs = dispatchRetryDelayMs(dispatch.attemptCount);
      await this.options.store.retryExecutionDispatch(
        dispatch.runId,
        dispatch.leaseId,
        limitError(`Agent 派发重试中：${message}`),
        delayMs,
      ).catch((retryError) => {
        this.options.logger?.warn(
          `Taskboard execution dispatch retry persistence failed: run=${dispatch.runId} error=${retryError instanceof Error ? retryError.message : String(retryError)}`,
        );
      });
      this.options.logger?.warn(
        `Taskboard execution dispatch deferred: run=${dispatch.runId} attempt=${dispatch.attemptCount} delayMs=${delayMs} error=${message}`,
      );
      return false;
    }
  }

  private async reconcileRunRecord(
    run: RunRecord,
    candidate: TaskboardExecutionReconcileCandidate,
  ): Promise<void> {
    if (isTerminalRunWithinGrace(run)) return;
    if (run.status === 'running') {
      await this.options.store.setExecutionStatusFromReconcile(run.runId, 'running', candidate.leaseId);
      return;
    }
    if (run.status === 'waiting_user' || run.status === 'waiting_approval') {
      await this.options.store.setExecutionStatusFromReconcile(run.runId, run.status, candidate.leaseId);
      return;
    }
    if (run.status === 'completed') {
      await this.completeSuccessfulRun(run.runId, run.sessionId, candidate.leaseId);
      return;
    }
    if (run.status === 'failed' || run.status === 'orphaned' || run.status === 'cancelled') {
      const status = run.status === 'cancelled' ? 'cancelled' : 'failed';
      const reason = run.statusReason || `Runtime 状态：${run.status}`;
      await this.completeFailedRun(run.runId, run.sessionId, status, reason, candidate.leaseId);
    }
  }

  async prepareWake(record: RunRecord): Promise<RunRecord> {
    if (record.metadata?.taskboardExecution !== true) return record;
    const context = await this.options.store.getExecutionContextByRunId(record.runId);
    if (!context) throw new Error(`任务看板执行记录不存在：${record.runId}`);
    assertExecutionSession(context.execution, record.sessionId);
    if (record.metadata?.taskboardExecutionId !== context.execution.id) {
      throw new Error(`Runtime Run 与任务看板 Execution 不匹配：run=${record.runId}`);
    }
    if (isTerminalExecution(context.execution)) {
      throw new Error(`任务看板执行已终止：${context.execution.status}`);
    }
    const persistedModelRef = record.model?.trim();
    if (
      persistedModelRef
      && this.options.resolveModel
      && !this.options.resolveModel(persistedModelRef, context.identity.tenantId)
    ) {
      throw new TaskboardExecutionUnavailableError(`指定模型不可用：${persistedModelRef}`);
    }
    const started = await this.options.store.setExecutionStatus(record.runId, 'running');
    if (!started) {
      throw new Error(`任务看板执行已终止：${record.runId}`);
    }
    return {
      ...record,
      metadata: {
        ...record.metadata,
        wakeMessage: {
          channel: 'web',
          chatId: record.sessionId,
          content: buildExecutionPrompt(
            context,
            this.options.timezone,
            this.options.resolveUserDisplayName?.(context.identity.ownerUserId),
          ),
          senderId: context.identity.ownerUserId,
          metadata: {
            taskboardExecution: true,
            taskboardExecutionId: context.execution.id,
            taskboardTaskId: context.task.id,
          },
        },
      },
    };
  }

  async handleRuntimeEvent(event: PlatformEvent): Promise<void> {
    const runId = 'runId' in event && typeof event.runId === 'string' ? event.runId : undefined;
    if (!runId) return;
    const run = await this.options.runStore.get(runId);
    if (run?.metadata?.taskboardContinuation === true) {
      await this.handleContinuationRuntimeEvent(event, run);
      return;
    }
    if (event.type === 'run_started') {
      await this.options.store.setExecutionStatus(runId, 'running');
      return;
    }
    if (event.type === 'run_state_changed') {
      if (event.status === 'waiting_user' || event.status === 'waiting_approval') {
        await this.options.store.setExecutionStatus(runId, event.status);
        return;
      }
      if (event.status === 'failed' || event.status === 'orphaned' || event.status === 'cancelled') {
        const status = event.status === 'cancelled' ? 'cancelled' : 'failed';
        const reason = event.reason || `Runtime 状态：${event.status}`;
        await this.completeFailedRun(runId, event.sessionId, status, reason);
      }
      return;
    }
    if (event.type !== 'run_finished') return;
    if (event.subtype === 'success') {
      await this.completeSuccessfulRun(runId, event.sessionId);
      return;
    }
    const reason = event.error || 'Agent 执行失败';
    await this.completeFailedRun(runId, event.sessionId, 'failed', reason);
  }

  private async handleContinuationRuntimeEvent(event: PlatformEvent, run: RunRecord): Promise<void> {
    const taskId = typeof run.metadata?.taskboardTaskId === 'string'
      ? run.metadata.taskboardTaskId
      : undefined;
    if (typeof run.metadata?.steeringTargetRunId === 'string') {
      if (!isTerminalRun(run)) return;
      if (run.status === 'completed' && run.metadata?.steeringState === 'applied') {
        await this.options.store.finishContinuation(run.runId);
        return;
      }
      if (!taskId) return;
      const reason = run.statusReason || `Runtime steering source 状态：${run.status}`;
      await this.options.store.completeContinuation(taskId, run.runId, {
        status: run.status === 'cancelled' ? 'cancelled' : 'failed',
        error: reason,
        commentBody: limitComment(`Agent 继续执行${run.status === 'cancelled' ? '已取消' : '失败'}\n\n${reason}`),
      });
      return;
    }
    if (!taskId) return;
    if (event.type === 'run_started') {
      await this.options.store.markContinuationRunning(taskId, run.runId);
      return;
    }
    if (event.type === 'run_state_changed'
      && (event.status === 'failed' || event.status === 'orphaned' || event.status === 'cancelled')) {
      const reason = event.reason || `Runtime 状态：${event.status}`;
      await this.options.store.completeContinuation(taskId, run.runId, {
        status: event.status === 'cancelled' ? 'cancelled' : 'failed',
        error: reason,
        commentBody: limitComment(`Agent 继续执行${event.status === 'cancelled' ? '已取消' : '失败'}\n\n${reason}`),
      });
      return;
    }
    if (event.type !== 'run_finished') return;
    if (event.subtype !== 'success') {
      const reason = event.error || 'Agent 继续执行失败';
      await this.options.store.completeContinuation(taskId, run.runId, {
        status: 'failed',
        error: reason,
        commentBody: limitComment(`Agent 继续执行失败\n\n${reason}`),
      });
      return;
    }
    const events = this.options.eventStore.listByRun
      ? await this.options.eventStore.listByRun(run.sessionId, run.runId)
      : await this.options.eventStore.list(run.sessionId);
    const output = finalAssistantText(events, run.runId, run.sessionId)
      || 'Agent 继续执行完成，但没有返回文本交付。';
    const attachments = await extractContinuationAttachments(output, run, this.options.agentCwd);
    await this.options.store.completeContinuation(taskId, run.runId, {
      status: 'succeeded',
      commentBody: limitComment(`Agent 交付\n\n${stripFileMarkers(output)}`),
      ...(attachments.length ? { attachments } : {}),
    });
  }

  private async completeSuccessfulRun(
    runId: string,
    sessionId: string,
    reconcileLeaseId?: string,
  ): Promise<void> {
    const context = await this.options.store.getExecutionContextByRunId(runId);
    if (!context || isTerminalExecution(context.execution)) return;
    assertExecutionSession(context.execution, sessionId);
    const events = this.options.eventStore.listByRun
      ? await this.options.eventStore.listByRun(sessionId, runId)
      : await this.options.eventStore.list(sessionId);
    const output = finalAssistantText(events, runId, sessionId)
      || 'Agent 执行完成，但没有返回文本交付。';
    const userCwd = resolveUserCwd(this.options.agentCwd, {
      id: context.identity.ownerUserId,
      username: context.identity.username,
      role: context.identity.userRole ?? 'user',
      tenantId: context.identity.tenantId,
    });
    const attachments = await extractAgentAttachments(output, userCwd);
    const completion = {
      status: 'succeeded' as const,
      commentBody: limitComment(`Agent 交付\n\n${stripFileMarkers(output)}`),
      ...(attachments.length ? { attachments } : {}),
    };
    if (reconcileLeaseId) {
      await this.options.store.completeExecutionFromReconcile(runId, completion, reconcileLeaseId);
    } else {
      await this.options.store.completeExecution(runId, completion);
    }
  }

  private async completeFailedRun(
    runId: string,
    sessionId: string,
    status: 'failed' | 'cancelled',
    reason: string,
    reconcileLeaseId?: string,
  ): Promise<void> {
    const context = await this.options.store.getExecutionContextByRunId(runId);
    if (!context || isTerminalExecution(context.execution)) return;
    assertExecutionSession(context.execution, sessionId);
    const completion = {
      status,
      error: reason,
      commentBody: limitComment(`Agent 执行${status === 'cancelled' ? '已取消' : '失败'}\n\n${reason}`),
    };
    if (reconcileLeaseId) {
      await this.options.store.completeExecutionFromReconcile(runId, completion, reconcileLeaseId);
    } else {
      await this.options.store.completeExecution(runId, completion);
    }
  }
}

function canonicalizeDispatchPayload(
  dispatch: TaskboardExecutionDispatch,
  agentCwd: string,
): TaskboardExecutionDispatch['payload'] {
  const payload = dispatch.payload as unknown;
  if (!isRecord(payload) || payload.version !== 1 || !isRecord(payload.session) || !isRecord(payload.run)) {
    throw new InvalidTaskboardDispatchPayloadError(`执行派发 payload 版本或结构无效：${dispatch.runId}`);
  }
  const session = payload.session;
  const run = payload.run;
  const userRole = session.userRole === undefined ? 'user' : session.userRole;
  if (
    dispatch.outboxExecutionId !== dispatch.executionId
    || !isNonEmptyString(dispatch.taskId)
    || !isNonEmptyString(dispatch.sessionId)
    || !isNonEmptyString(dispatch.tenantId)
    || !isNonEmptyString(dispatch.ownerUserId)
    || run.runId !== dispatch.runId
    || run.sessionId !== dispatch.sessionId
    || session.sessionId !== dispatch.sessionId
    || run.userId !== dispatch.ownerUserId
    || session.userId !== dispatch.ownerUserId
    || run.tenantId !== dispatch.tenantId
    || session.tenantId !== dispatch.tenantId
    || !isNonEmptyString(session.username)
    || (userRole !== 'admin' && userRole !== 'user')
    || session.channel !== 'web'
    || run.channel !== 'web'
    || session.status !== 'running'
    || !isNonEmptyString(run.model)
    || session.modelRef !== run.model
    || !isExecutionTarget(run.executionTarget)
    || session.executionTarget !== run.executionTarget
    || !isNonEmptyString(session.cwd)
    || !isNonEmptyString(session.transcriptPath)
    || !isIsoTimestamp(session.createdAt)
    || !isIsoTimestamp(session.updatedAt)
    || run.idempotencyKey !== `taskboard-execution:${dispatch.executionId}`
  ) {
    throw new InvalidTaskboardDispatchPayloadError(`执行派发 payload 关联字段不一致：${dispatch.runId}`);
  }
  const canonicalUserRole = userRole as 'admin' | 'user';
  const executionTarget = run.executionTarget as 'server-local' | 'server-container' | 'server-remote' | 'client';
  const workspaceUser = {
    id: dispatch.ownerUserId,
    username: session.username,
    role: canonicalUserRole,
    tenantId: dispatch.tenantId,
  };
  const expectedCwd = resolveUserCwd(agentCwd, workspaceUser);
  const expectedWorkspaceId = deriveStableWorkspaceId(workspaceUser, dispatch.sessionId);
  const expectedTranscriptPath = getTranscriptPath(expectedCwd, dispatch.sessionId, {
    userId: dispatch.ownerUserId,
    tenantId: dispatch.tenantId,
  });
  if (
    session.cwd !== expectedCwd
    || session.transcriptPath !== expectedTranscriptPath
    || session.workspaceId !== expectedWorkspaceId
    || run.workspaceId !== expectedWorkspaceId
  ) {
    throw new InvalidTaskboardDispatchPayloadError(`执行派发 payload 路径或 workspace 不合法：${dispatch.runId}`);
  }
  const canonicalSession = createRuntimeSessionRecord({
    sessionId: dispatch.sessionId,
    userId: dispatch.ownerUserId,
    username: session.username,
    userRole: canonicalUserRole,
    tenantId: dispatch.tenantId,
    channel: 'web',
    cwd: expectedCwd,
    modelRef: run.model,
    executionTarget,
    workspaceId: expectedWorkspaceId,
    status: 'running',
  });
  canonicalSession.createdAt = session.createdAt;
  canonicalSession.updatedAt = session.updatedAt;
  return {
    version: 1,
    session: canonicalSession,
    run: {
      runId: dispatch.runId,
      sessionId: dispatch.sessionId,
      userId: dispatch.ownerUserId,
      tenantId: dispatch.tenantId,
      model: run.model,
      channel: 'web',
      idempotencyKey: `taskboard-execution:${dispatch.executionId}`,
      executionTarget,
      workspaceId: expectedWorkspaceId,
      metadata: {
        taskboardExecution: true,
        taskboardExecutionId: dispatch.executionId,
        taskboardTaskId: dispatch.taskId,
        outputTransactionMode: 'terminal_buffered',
        cwd: expectedCwd,
        transcriptPath: expectedTranscriptPath,
        wakeMessage: {
          channel: 'web',
          chatId: dispatch.sessionId,
          content: '正在读取任务看板中的最新任务与评论。',
          senderId: dispatch.ownerUserId,
          senderName: session.username,
          metadata: {
            taskboardExecution: true,
            taskboardExecutionId: dispatch.executionId,
            taskboardTaskId: dispatch.taskId,
          },
        },
      },
    },
  };
}

function assertDispatchedRun(
  run: RunRecord,
  dispatch: TaskboardExecutionDispatch,
  expected: TaskboardExecutionDispatch['payload']['run'],
): void {
  const metadata = run.metadata;
  const expectedMetadata = expected.metadata;
  const wakeMessage = metadata?.wakeMessage;
  const wakeMetadata = isRecord(wakeMessage) ? wakeMessage.metadata : undefined;
  if (
    run.runId !== expected.runId
    || run.sessionId !== expected.sessionId
    || run.userId !== expected.userId
    || run.tenantId !== expected.tenantId
    || run.model !== expected.model
    || run.channel !== expected.channel
    || run.idempotencyKey !== expected.idempotencyKey
    || run.executionTarget !== expected.executionTarget
    || run.workspaceId !== expected.workspaceId
    || run.sandboxScopeId !== undefined
    || !isRecord(expectedMetadata)
    || metadata?.taskboardExecution !== true
    || metadata?.taskboardExecutionId !== dispatch.executionId
    || metadata?.taskboardTaskId !== dispatch.taskId
    || metadata?.outputTransactionMode !== 'terminal_buffered'
    || expectedMetadata.outputTransactionMode !== 'terminal_buffered'
    || metadata?.cwd !== expectedMetadata.cwd
    || metadata?.transcriptPath !== expectedMetadata.transcriptPath
    || metadata?.backgroundTask === true
    || metadata?.backgroundCommand === true
    || metadata?.subagent === true
    || metadata?.toolProfile !== undefined
    || metadata?.approvalPolicy !== undefined
    || !isRecord(wakeMessage)
    || wakeMessage.channel !== 'web'
    || wakeMessage.chatId !== dispatch.sessionId
    || wakeMessage.senderId !== dispatch.ownerUserId
    || !isRecord(wakeMetadata)
    || wakeMetadata.taskboardExecution !== true
    || wakeMetadata.taskboardExecutionId !== dispatch.executionId
    || wakeMetadata.taskboardTaskId !== dispatch.taskId
  ) {
    throw new InvalidTaskboardDispatchPayloadError(`既有 Runtime Run 与执行派发不一致：${dispatch.runId}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isExecutionTarget(value: unknown): boolean {
  return value === 'server-local'
    || value === 'server-container'
    || value === 'server-remote'
    || value === 'client';
}

function assertExecutionSession(execution: TaskBoardExecution, sessionId: string): void {
  if (execution.sessionId !== sessionId) {
    throw new Error(`Runtime session 与任务看板 Execution 不匹配：run=${execution.runId}`);
  }
}

function finalAssistantText(events: PlatformEvent[], runId: string, sessionId: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type !== 'assistant_message'
      || event.incomplete
      || event.runId !== runId
      || event.sessionId !== sessionId
    ) continue;
    const content = event.content?.trim();
    if (content) return content;
  }
  return '';
}

function limitComment(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 20_000) return normalized;
  return `${normalized.slice(0, 19_950)}\n\n[回执内容过长，已截断]`;
}

function limitError(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 1_980)}…`;
}

function dispatchRetryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(attemptCount - 1, 0), 6)));
}

function matchesReconcileCandidate(
  run: RunRecord,
  candidate: TaskboardExecutionReconcileCandidate,
): boolean {
  return run.runId === candidate.runId
    && run.sessionId === candidate.sessionId
    && run.metadata?.taskboardExecution === true
    && run.metadata?.taskboardExecutionId === candidate.executionId;
}

function isTerminalRunWithinGrace(run: RunRecord): boolean {
  const terminalAt = run.status === 'completed'
    ? run.completedAt ?? run.updatedAt
    : run.status === 'failed'
      ? run.failedAt ?? run.updatedAt
      : run.status === 'cancelled'
        ? run.cancelledAt ?? run.updatedAt
        : run.status === 'orphaned'
          ? run.updatedAt
          : undefined;
  if (!terminalAt) return false;
  const terminalAtMs = Date.parse(terminalAt);
  return Number.isFinite(terminalAtMs) && terminalAtMs > Date.now() - RECONCILIATION_GRACE_MS;
}

function isTerminalRun(run: RunRecord): boolean {
  return run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'cancelled'
    || run.status === 'orphaned';
}

function isTerminalExecution(execution: TaskBoardExecution): boolean {
  return execution.status === 'succeeded'
    || execution.status === 'failed'
    || execution.status === 'cancelled';
}
