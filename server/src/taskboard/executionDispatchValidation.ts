import { getTranscriptPath } from '../data/transcripts/store.js';
import type { RunRecord } from '../runtime/runStore.js';
import {
  SCHEDULER_STATE_METADATA_KEY,
  SCHEDULER_STATE_READY,
  SCHEDULER_STATE_STAGED,
} from '../runtime/scheduler.js';
import { createRuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import type { TaskboardExecutionDispatch } from './types.js';

export class InvalidTaskboardDispatchPayloadError extends Error {}

export function canonicalizeDispatchPayload(
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
        [SCHEDULER_STATE_METADATA_KEY]: SCHEDULER_STATE_STAGED,
        cwd: expectedCwd,
        transcriptPath: expectedTranscriptPath,
        // 首跑重建 Session 所需字段（runtimeWakeSessionRestore 契约）：
        // 文件投影跨进程/重启可能暂时缺失，wake 需要从 run.metadata 重建。
        username: session.username,
        ...(canonicalUserRole ? { userRole: canonicalUserRole } : {}),
        modelRef: run.model,
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

export function assertDispatchedRun(
  run: RunRecord,
  dispatch: TaskboardExecutionDispatch,
  expected: TaskboardExecutionDispatch['payload']['run'],
): void {
  const metadata = run.metadata;
  const expectedMetadata = expected.metadata;
  const schedulerState = metadata?.[SCHEDULER_STATE_METADATA_KEY];
  const wakeMessage = metadata?.wakeMessage;
  const wakeMetadata = isRecord(wakeMessage) ? wakeMessage.metadata : undefined;
  const wakeMessageMayBeConsumed = run.status === 'running' || isTerminalRun(run);
  const wakeMessageInvalid = wakeMessage === undefined
    ? !wakeMessageMayBeConsumed
    : !isRecord(wakeMessage)
      || wakeMessage.channel !== 'web'
      || wakeMessage.chatId !== dispatch.sessionId
      || wakeMessage.senderId !== dispatch.ownerUserId
      || !isRecord(wakeMetadata)
      || wakeMetadata.taskboardExecution !== true
      || wakeMetadata.taskboardExecutionId !== dispatch.executionId
      || wakeMetadata.taskboardTaskId !== dispatch.taskId;
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
    || expectedMetadata[SCHEDULER_STATE_METADATA_KEY] !== SCHEDULER_STATE_STAGED
    || (schedulerState !== SCHEDULER_STATE_STAGED
      && schedulerState !== SCHEDULER_STATE_READY
      && !(schedulerState === undefined && wakeMessageMayBeConsumed))
    || metadata?.cwd !== expectedMetadata.cwd
    || metadata?.transcriptPath !== expectedMetadata.transcriptPath
    || metadata?.username !== expectedMetadata.username
    || metadata?.userRole !== expectedMetadata.userRole
    || metadata?.modelRef !== expectedMetadata.modelRef
    || metadata?.backgroundTask === true
    || metadata?.backgroundCommand === true
    || metadata?.subagent === true
    || metadata?.toolProfile !== undefined
    || metadata?.approvalPolicy !== undefined
    || wakeMessageInvalid
  ) {
    throw new InvalidTaskboardDispatchPayloadError(`既有 Runtime Run 与执行派发不一致：${dispatch.runId}`);
  }
}

function isTerminalRun(run: RunRecord): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
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
