import { randomUUID } from 'node:crypto';

import type { RunRecord, RunStore } from '../runtime/runStore.js';
import type { RuntimeScheduler } from '../runtime/scheduler.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore } from '../runtime/types.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { reconcileTerminalContinuation } from './continuationCompletion.js';
import type {
  TaskboardContinuationDispatch,
  TaskboardContinuationReconcileCandidate,
  TaskboardExecutionStore,
} from './types.js';

const RECONCILIATION_GRACE_MS = 30_000;

class InvalidContinuationDispatchPayloadError extends Error {}

export interface TaskboardContinuationCoordinatorOptions {
  store: TaskboardExecutionStore;
  scheduler: Pick<RuntimeScheduler, 'enqueue'>;
  runStore: Pick<RunStore, 'get'>;
  sessionCatalog: SessionCatalog;
  eventStore: EventStore;
  agentCwd: string;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export async function dispatchTaskboardContinuation(
  options: TaskboardContinuationCoordinatorOptions,
  runId?: string,
): Promise<boolean> {
  const leaseId = randomUUID();
  const dispatch = await options.store.claimContinuationDispatch(runId, leaseId).catch((error) => {
    options.logger?.warn(
      `Taskboard continuation dispatch claim failed: run=${runId ?? 'next'} error=${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  if (!dispatch) return false;
  try {
    const payload = canonicalizeContinuationDispatch(dispatch, options.agentCwd);
    await options.sessionCatalog.upsert(payload.session);
    const run = await options.scheduler.enqueue(payload.run, { steeringAware: true });
    assertContinuationRun(run, dispatch);
    await options.store.markContinuationDispatchSucceeded(dispatch.runId, dispatch.leaseId);
    options.logger?.info(`Taskboard continuation queued: run=${dispatch.runId}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof InvalidContinuationDispatchPayloadError) {
      await options.store.completeContinuation(dispatch.taskId, dispatch.runId, {
        status: 'failed',
        error: message,
        commentBody: limitComment(`Agent 继续执行失败\n\n${message}`),
      });
      return true;
    }
    const delayMs = dispatchRetryDelayMs(dispatch.attemptCount);
    await options.store.retryContinuationDispatch(
      dispatch.runId,
      dispatch.leaseId,
      limitError(`Agent 继续派发重试中：${message}`),
      delayMs,
    ).catch((retryError) => {
      options.logger?.warn(
        `Taskboard continuation retry persistence failed: run=${dispatch.runId} error=${retryError instanceof Error ? retryError.message : String(retryError)}`,
      );
    });
    return false;
  }
}

export async function reconcileTaskboardContinuation(
  options: TaskboardContinuationCoordinatorOptions,
  candidate: TaskboardContinuationReconcileCandidate,
): Promise<void> {
  const run = await options.runStore.get(candidate.runId);
  if (!run) {
    await failContinuation(options.store, candidate, '评论续跑 Runtime Run 不存在');
    return;
  }
  if (!matchesContinuationCandidate(run, candidate)) {
    await failContinuation(options.store, candidate, 'Runtime Run 与任务看板评论续跑关联校验失败');
    return;
  }
  if (isTerminalRunWithinGrace(run)) return;
  if (typeof run.metadata?.steeringTargetRunId === 'string') {
    if (!isTerminalRun(run)) {
      await options.store.releaseContinuationReconcile(run.runId, candidate.leaseId);
      return;
    }
    if (run.status === 'completed' && run.metadata?.steeringState === 'applied') {
      await options.store.finishContinuation(run.runId, candidate.leaseId);
      return;
    }
    const reason = run.statusReason || `Runtime steering source 状态：${run.status}`;
    await options.store.completeContinuation(candidate.taskId, run.runId, {
      status: run.status === 'cancelled' ? 'cancelled' : 'failed',
      error: reason,
      commentBody: limitComment(`Agent 继续执行${run.status === 'cancelled' ? '已取消' : '失败'}\n\n${reason}`),
    });
    return;
  }
  if (isTerminalRun(run)) {
    await reconcileTerminalContinuation({
      store: options.store,
      eventStore: options.eventStore,
      taskId: candidate.taskId,
      run,
    });
    return;
  }
  if (run.status === 'pending' || run.status === 'running') {
    await options.store.markContinuationRunning(candidate.taskId, run.runId, candidate.leaseId);
  }
  await options.store.releaseContinuationReconcile(run.runId, candidate.leaseId);
}

function canonicalizeContinuationDispatch(
  dispatch: TaskboardContinuationDispatch,
  agentCwd: string,
): TaskboardContinuationDispatch['payload'] {
  const payload = dispatch.payload as unknown;
  if (!isRecord(payload) || payload.version !== 1 || !isRecord(payload.session) || !isRecord(payload.run)) {
    throw new InvalidContinuationDispatchPayloadError(`评论续跑 payload 版本或结构无效：${dispatch.runId}`);
  }
  const session = payload.session;
  const run = payload.run;
  const metadata = run.metadata;
  const wakeMessage = isRecord(metadata) ? metadata.wakeMessage : undefined;
  const wakeMetadata = isRecord(wakeMessage) ? wakeMessage.metadata : undefined;
  const workspaceUser = {
    id: dispatch.ownerUserId,
    username: String(session.username ?? ''),
    role: session.userRole === 'admin' ? 'admin' as const : 'user' as const,
    tenantId: dispatch.tenantId,
  };
  const expectedCwd = resolveUserCwd(agentCwd, workspaceUser);
  const expectedWorkspaceId = deriveStableWorkspaceId(workspaceUser, dispatch.sessionId);
  if (
    run.runId !== dispatch.runId || run.sessionId !== dispatch.sessionId
    || session.sessionId !== dispatch.sessionId || run.userId !== dispatch.ownerUserId
    || session.userId !== dispatch.ownerUserId || run.tenantId !== dispatch.tenantId
    || session.tenantId !== dispatch.tenantId || session.cwd !== expectedCwd
    || session.workspaceId !== expectedWorkspaceId || run.workspaceId !== expectedWorkspaceId
    || run.idempotencyKey !== `taskboard-comment:${dispatch.commentId}` || !isRecord(metadata)
    || metadata.taskboardContinuation !== true || metadata.taskboardTaskId !== dispatch.taskId
    || metadata.taskboardCommentId !== dispatch.commentId || !isRecord(wakeMessage)
    || wakeMessage.chatId !== dispatch.sessionId || wakeMessage.senderId !== dispatch.ownerUserId
    || !isRecord(wakeMetadata) || wakeMetadata.taskboardContinuation !== true
    || wakeMetadata.taskboardTaskId !== dispatch.taskId || wakeMetadata.taskboardCommentId !== dispatch.commentId
  ) {
    throw new InvalidContinuationDispatchPayloadError(`评论续跑 payload 关联字段不一致：${dispatch.runId}`);
  }
  return dispatch.payload;
}

function assertContinuationRun(run: RunRecord, dispatch: TaskboardContinuationDispatch): void {
  if (
    run.runId !== dispatch.runId || run.sessionId !== dispatch.sessionId
    || run.metadata?.taskboardContinuation !== true
    || run.metadata?.taskboardTaskId !== dispatch.taskId
    || run.metadata?.taskboardCommentId !== dispatch.commentId
  ) {
    throw new InvalidContinuationDispatchPayloadError(`既有 Runtime Run 与评论续跑不一致：${dispatch.runId}`);
  }
}

function matchesContinuationCandidate(
  run: RunRecord,
  candidate: TaskboardContinuationReconcileCandidate,
): boolean {
  return run.runId === candidate.runId && run.sessionId === candidate.sessionId
    && run.metadata?.taskboardContinuation === true
    && run.metadata?.taskboardTaskId === candidate.taskId;
}

function isTerminalRunWithinGrace(run: RunRecord): boolean {
  const terminalAt = run.status === 'completed' ? run.completedAt ?? run.updatedAt
    : run.status === 'failed' ? run.failedAt ?? run.updatedAt
      : run.status === 'cancelled' ? run.cancelledAt ?? run.updatedAt
        : run.status === 'orphaned' ? run.updatedAt : undefined;
  if (!terminalAt) return false;
  const terminalAtMs = Date.parse(terminalAt);
  return Number.isFinite(terminalAtMs) && terminalAtMs > Date.now() - RECONCILIATION_GRACE_MS;
}

function isTerminalRun(run: RunRecord): boolean {
  return run.status === 'completed' || run.status === 'failed'
    || run.status === 'cancelled' || run.status === 'orphaned';
}

async function failContinuation(
  store: TaskboardExecutionStore,
  candidate: TaskboardContinuationReconcileCandidate,
  reason: string,
): Promise<void> {
  await store.completeContinuation(candidate.taskId, candidate.runId, {
    status: 'failed',
    error: reason,
    commentBody: limitComment(`Agent 继续执行失败\n\n${reason}`),
  });
}

function dispatchRetryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(attemptCount - 1, 0), 6)));
}

function limitComment(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 20_000
    ? normalized
    : `${normalized.slice(0, 19_950)}\n\n[回执内容过长，已截断]`;
}

function limitError(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 1_980)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
