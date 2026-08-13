import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { splitByMessageMarkers } from '../../../shared/src/lib/markers.js';
import type {
  TaskBoardAttachment,
  TaskBoardComment,
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
import { formatDateTime } from '../utils/timestamp.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { isInside, resolveWorkspacePath, relativeWorkspacePath } from '../agent/toolRuntimePaths.js';
import { TaskboardExecutionUnavailableError, TaskboardPermissionError } from './types.js';
export { createTaskboardRuntimeOptions } from './runtimeOptions.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionDispatch,
  TaskboardExecutionReconcileCandidate,
  TaskboardExecutionService,
  TaskboardExecutionStore,
  TaskboardIdentity,
} from './types.js';

interface DefaultModelResolution {
  ref: string;
}

const RECONCILIATION_GRACE_MS = 30_000;

class InvalidTaskboardDispatchPayloadError extends Error {}

export interface TaskboardExecutionCoordinatorOptions {
  store: TaskboardExecutionStore;
  scheduler: Pick<RuntimeScheduler, 'enqueueCreateOnly'>;
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

  async startExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardExecutionStartInput,
  ): Promise<TaskBoardExecutionStartResult> {
    const modelContext = await this.options.store.getExecutionModelContext(identity, taskId);
    if (modelContext.boardOwnerUserId !== identity.ownerUserId) {
      throw new TaskboardPermissionError('Only the board owner may dispatch an Agent for this board');
    }
    const executionIdentity = identity;
    if (!executionIdentity || executionIdentity.tenantId !== identity.tenantId) {
      throw new TaskboardExecutionUnavailableError('看板创建者账号不可用，无法继承其运行上下文');
    }
    const explicitModelRef = modelContext.taskModel ?? modelContext.boardModel;
    const model = explicitModelRef
      ? this.options.resolveModel?.(explicitModelRef, executionIdentity.tenantId)
      : this.options.resolveDefaultModel(executionIdentity.tenantId);
    if (!model) {
      const reason = explicitModelRef
        ? `指定模型不可用：${explicitModelRef}`
        : '当前组织没有可用的默认模型';
      throw new TaskboardExecutionUnavailableError(reason);
    }
    const executionDecision = resolveExecutionTarget({
      user: { role: executionIdentity.userRole, tenantId: executionIdentity.tenantId },
      config: this.options.executionConfig,
    });
    if (!executionDecision.ok) throw new TaskboardExecutionUnavailableError(executionDecision.reason);

    const executionId = randomUUID();
    const sessionId = `taskboard-${randomUUID()}`;
    const runId = `taskboard-${Date.now()}-${randomUUID()}`;
    const workspaceUser = {
      id: executionIdentity.ownerUserId,
      username: executionIdentity.username,
      role: executionIdentity.userRole ?? 'user' as const,
      tenantId: executionIdentity.tenantId,
    };
    const cwd = resolveUserCwd(this.options.agentCwd, workspaceUser);
    const workspaceId = deriveStableWorkspaceId(workspaceUser, sessionId);
    const session = createRuntimeSessionRecord({
      sessionId,
      userId: executionIdentity.ownerUserId,
      username: executionIdentity.username,
      userRole: executionIdentity.userRole,
      tenantId: executionIdentity.tenantId,
      channel: 'web',
      cwd,
      modelRef: model.ref,
      executionTarget: executionDecision.target,
      workspaceId,
      status: 'running',
    });
    const run = {
      runId,
      sessionId,
      userId: executionIdentity.ownerUserId,
      tenantId: executionIdentity.tenantId,
      model: model.ref,
      channel: 'taskboard',
      idempotencyKey: `taskboard-execution:${executionId}`,
      executionTarget: executionDecision.target,
      workspaceId,
      metadata: {
        taskboardExecution: true,
        taskboardExecutionId: executionId,
        taskboardTaskId: taskId,
        outputTransactionMode: 'terminal_buffered',
        cwd,
        transcriptPath: session.transcriptPath,
        wakeMessage: {
          channel: 'web',
          chatId: sessionId,
          content: '正在读取任务看板中的最新任务与评论。',
          senderId: executionIdentity.ownerUserId,
          senderName: executionIdentity.username,
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
      ...(explicitModelRef ? { configuredModelRef: explicitModelRef } : {}),
      executionOwnerUserId: executionIdentity.ownerUserId,
      dispatch: { version: 1, session, run },
    });
    await this.dispatchExecution(runId);
    return claimed;
  }

  async reconcile(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      const dispatched = await this.dispatchExecution();
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
      await this.options.sessionCatalog.ensure(canonical.session);
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
    || run.channel !== 'taskboard'
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
      channel: 'taskboard',
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

function buildExecutionPrompt(
  context: TaskboardExecutionContext,
  timezone?: string,
  ownerDisplayName?: string,
): string {
  const task = context.task;
  const recentComments = context.comments.slice(-50);
  const comments = recentComments.length > 0
    ? recentComments.map((comment) => formatComment(
        comment,
        timezone,
        comment.authorType === 'user' && comment.authorId === context.identity.ownerUserId
          ? ownerDisplayName
          : undefined,
      )).join('\n\n')
    : '（暂无评论）';
  return [
    '看板提示语：',
    context.boardPrompt || '（无）',
    '',
    `任务：${task.identifier} · ${task.title}`,
    `任务记录 ID：${task.id}`,
    `执行类型：${context.execution.purpose === 'review' ? '独立复核' : '实施'}`,
    `工作分支：${task.branch ?? '未填写'}`,
    `优先级：${task.priority}`,
    `标签：${task.labels.length > 0 ? task.labels.join('、') : '无'}`,
    `截止时间：${task.dueAt ?? '无'}`,
    '',
    '任务看板回写：',
    ...executionWritebackInstructions(context),
    '',
    '任务正文：',
    task.description || '（无正文）',
    '',
    '任务附件：',
    formatAttachments(task.attachments ?? []),
    '',
    `最近评论（${recentComments.length}/${context.comments.length}）：`,
    comments,
  ].join('\n');
}

export function executionWritebackInstructions(context: TaskboardExecutionContext): string[] {
  const taskId = context.task.id;
  const boardId = context.task.boardId;
  const common = [
    `- 创建或确认工作分支后，调用 CronManage：target=taskboard, action=update, id=${taskId}, branch=<分支名>。`,
    `- 需要独立的后续复核、返工或合并时，用 target=taskboard, action=create, boardId=${boardId}, status=todo, dispatch=true 创建并派发新任务。`,
  ];
  if (context.execution.purpose !== 'review') {
    return [...common, '- 实施成功后不要标记 done；系统会把仍在进行中的任务送入待复核。'];
  }
  return [
    ...common,
    '- 本次只做独立复核，不顺手修改交付。',
    `- 复核通过：调用 CronManage：target=taskboard, action=move, id=${taskId}, status=done。`,
    `- 复核不通过：调用 CronManage：target=taskboard, action=move, id=${taskId}, status=todo；最终回执列明返工项。`,
    '- 无法明确判定时不要移动状态；系统会把任务放回待复核。',
  ];
}

function formatComment(
  comment: TaskBoardComment,
  timezone?: string,
  currentAuthorName?: string,
): string {
  const createdAt = new Date(comment.createdAt);
  const timestamp = Number.isNaN(createdAt.getTime())
    ? comment.createdAt
    : formatDateTime(createdAt, timezone);
  const attachments = comment.attachments?.length
    ? `\n附件：\n${formatAttachments(comment.attachments)}`
    : '';
  return `[${timestamp}] ${currentAuthorName || comment.authorName}（${comment.authorType}）\n${comment.body || '（无文字）'}${attachments}`;
}

function formatAttachments(attachments: readonly TaskBoardAttachment[]): string {
  if (attachments.length === 0) return '（无附件）';
  return attachments.map((attachment) => `- ${attachment.originalName}：${attachment.relativePath}`).join('\n');
}

function assertExecutionSession(execution: TaskBoardExecution, sessionId: string): void {
  if (execution.sessionId !== sessionId) {
    throw new Error(`Runtime session 与任务看板 Execution 不匹配：run=${execution.runId}`);
  }
}

async function extractAgentAttachments(output: string, userCwd: string): Promise<TaskBoardAttachment[]> {
  let realUserCwd: string;
  try {
    realUserCwd = await realpath(userCwd);
  } catch {
    return [];
  }
  const paths = [...new Set(splitByMessageMarkers(output)
    .filter((segment): segment is Extract<ReturnType<typeof splitByMessageMarkers>[number], { type: 'file' }> => (
      segment.type === 'file' && Boolean(segment.filePath)
    ))
    .map((segment) => segment.filePath))]
    .slice(0, 50);
  const attachments = await Promise.all(paths.map(async (filePath): Promise<TaskBoardAttachment | null> => {
    try {
      const absolutePath = resolveWorkspacePath(userCwd, filePath);
      const realFilePath = await realpath(absolutePath);
      if (!isInside(realUserCwd, realFilePath)) return null;
      const fileStat = await stat(realFilePath);
      if (!fileStat.isFile()) return null;
      const relativePath = relativeWorkspacePath(userCwd, absolutePath);
      const originalName = relativePath.split('/').pop() || relativePath;
      const mimeType = mimeTypeFromName(originalName);
      return {
        originalName,
        relativePath,
        size: fileStat.size,
        mimeType,
        isImage: mimeType.startsWith('image/'),
      };
    } catch {
      return null;
    }
  }));
  return attachments.filter((attachment): attachment is TaskBoardAttachment => attachment !== null);
}

function stripFileMarkers(output: string): string {
  return output.replace(/\[FILE\]\{.*?\}\[\/FILE\]/g, '').trim();
}

function mimeTypeFromName(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
  };
  return types[extension] ?? 'application/octet-stream';
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

function isTerminalExecution(execution: TaskBoardExecution): boolean {
  return execution.status === 'succeeded'
    || execution.status === 'failed'
    || execution.status === 'cancelled';
}
