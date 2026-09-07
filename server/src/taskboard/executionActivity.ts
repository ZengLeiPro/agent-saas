import { randomUUID } from 'node:crypto';

import type { TaskBoardExecution } from '../../../shared/src/types/taskboard.js';
import type { RunRecord, RunStore, RunStatus } from '../runtime/runStore.js';
import { isTerminalExecution } from './executionServiceUtils.js';
import {
  TaskboardExecutionUnavailableError,
  TaskboardNotFoundError,
  TaskboardValidationError,
} from './types.js';
import type {
  TaskboardExecutionActivityReconcileResult,
  TaskboardExecutionActivityResult,
  TaskboardExecutionStore,
  TaskboardIdentity,
  TaskboardSessionActivity,
} from './types.js';

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  'pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand',
]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'completed', 'failed', 'cancelled', 'orphaned',
]);
const MAX_ACTIVITY_RECORDS = 500;
const WAKE_CLAIM_STALE_MS = 60_000;

interface ExecutionActivityOptions {
  store: Pick<TaskboardExecutionStore, 'listExecutions'>;
  runStore: Partial<Pick<RunStore,
    'listBySession' | 'listBackgroundTasks' | 'claimBackgroundTaskWake' | 'finishBackgroundTaskWake'
  >>;
}

export async function inspectTaskboardExecutionActivity(
  options: ExecutionActivityOptions,
  identity: TaskboardIdentity,
  taskId: string,
  executionId: string,
): Promise<TaskboardExecutionActivityResult> {
  const execution = await requireExecution(options.store, identity, taskId, executionId);
  return {
    taskId,
    executionId,
    sessionId: execution.sessionId,
    activities: await collectSessionActivity(options.runStore, execution.sessionId, identity.tenantId),
  };
}

export async function reconcileTaskboardExecutionActivity(
  options: ExecutionActivityOptions,
  identity: TaskboardIdentity,
  taskId: string,
  executionId: string,
  input: { expectedVersion: number; reason: string; dryRun: boolean },
): Promise<TaskboardExecutionActivityReconcileResult> {
  const execution = await requireExecution(options.store, identity, taskId, executionId);
  if (!isTerminalExecution(execution)) {
    throw new TaskboardValidationError('活跃 Execution 应使用 execution.cancel，不能执行残留活动结算');
  }
  const inspected = await inspectTaskboardExecutionActivity(options, identity, taskId, executionId);
  if (input.dryRun) return { ...inspected, dryRun: true, discarded: [] };
  const claimWake = options.runStore.claimBackgroundTaskWake;
  const finishWake = options.runStore.finishBackgroundTaskWake;
  if (!claimWake || !finishWake) {
    throw new TaskboardExecutionUnavailableError('任务会话残留唤醒结算未启用');
  }
  const discarded: TaskboardSessionActivity[] = [];
  const staleBefore = new Date(Date.now() - WAKE_CLAIM_STALE_MS);
  for (const activity of inspected.activities) {
    if (activity.kind !== 'pending_wake') continue;
    const claimToken = randomUUID();
    const claimed = await claimWake.call(options.runStore, activity.runId, claimToken, staleBefore);
    if (!claimed || !isTerminalPendingWake(claimed)) continue;
    const finished = await finishWake.call(options.runStore, claimed.runId, claimToken, 'discarded', {
      wakeDiscardReason: 'taskboard_operator_reconcile',
      wakeReconcileReason: input.reason,
      wakeReconciledBy: identity.ownerUserId,
      wakeReconcileTaskId: taskId,
      wakeReconcileExecutionId: executionId,
      wakeReconcileExpectedTaskVersion: input.expectedVersion,
    });
    if (finished) discarded.push({ ...toActivity(finished), kind: 'pending_wake' });
  }
  return {
    taskId,
    executionId,
    sessionId: execution.sessionId,
    dryRun: false,
    discarded,
    activities: await collectSessionActivity(options.runStore, execution.sessionId, identity.tenantId),
  };
}

async function collectSessionActivity(
  runStore: ExecutionActivityOptions['runStore'],
  rootSessionId: string,
  tenantId: string,
): Promise<TaskboardSessionActivity[]> {
  const listBySession = runStore.listBySession;
  const listBackgroundTasks = runStore.listBackgroundTasks;
  if (!listBySession || !listBackgroundTasks) {
    throw new TaskboardExecutionUnavailableError('任务会话活动查询未启用');
  }
  const activities = new Map<string, TaskboardSessionActivity>();
  const sessions = [rootSessionId];
  const visited = new Set<string>();
  while (sessions.length > 0 && activities.size < MAX_ACTIVITY_RECORDS) {
    const sessionId = sessions.shift()!;
    if (visited.has(sessionId)) continue;
    visited.add(sessionId);
    const [runs, backgroundTasks] = await Promise.all([
      listBySession.call(runStore, sessionId, { limit: 100 }),
      listBackgroundTasks.call(runStore, sessionId, { tenantId, limit: 100 }),
    ]);
    for (const run of runs) {
      if (run.tenantId === tenantId && run.metadata.backgroundTask !== true
        && ACTIVE_RUN_STATUSES.has(run.status)) activities.set(run.runId, toActivity(run));
    }
    for (const task of backgroundTasks) {
      if (isActiveOrPendingWake(task)) activities.set(task.runId, toActivity(task));
      if (task.sessionId && !visited.has(task.sessionId)) sessions.push(task.sessionId);
    }
  }
  return [...activities.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function isActiveOrPendingWake(run: RunRecord): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status) || isTerminalPendingWake(run);
}

function isTerminalPendingWake(run: RunRecord): boolean {
  const wakeState = typeof run.metadata.wakeState === 'string' ? run.metadata.wakeState : 'pending';
  return run.metadata.backgroundTask === true
    && TERMINAL_RUN_STATUSES.has(run.status)
    && (wakeState === 'pending' || wakeState === 'delivering');
}

function toActivity(run: RunRecord): TaskboardSessionActivity {
  const wakeState = typeof run.metadata.wakeState === 'string' ? run.metadata.wakeState : undefined;
  const pendingWake = isTerminalPendingWake(run);
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    kind: pendingWake ? 'pending_wake' : run.metadata.backgroundTask === true ? 'background_task' : 'session_run',
    ...(typeof run.metadata.parentSessionId === 'string' ? { parentSessionId: run.metadata.parentSessionId } : {}),
    ...(typeof run.metadata.topLevelSessionId === 'string' ? { topLevelSessionId: run.metadata.topLevelSessionId } : {}),
    ...(wakeState ? { wakeState } : {}),
    ...(typeof run.metadata.wakeDeferredReason === 'string'
      ? { wakeDeferredReason: run.metadata.wakeDeferredReason }
      : {}),
    updatedAt: run.updatedAt,
  };
}

async function requireExecution(
  store: Pick<TaskboardExecutionStore, 'listExecutions'>,
  identity: TaskboardIdentity,
  taskId: string,
  executionId: string,
): Promise<TaskBoardExecution> {
  const execution = (await store.listExecutions(identity, taskId))
    .find((candidate) => candidate.id === executionId);
  if (!execution) throw new TaskboardNotFoundError('Taskboard execution not found');
  return execution;
}
