import type {
  TaskBoardExecution,
  TaskBoardExecutionPurpose,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import type { RunRecord } from '../runtime/runStore.js';
import {
  SCHEDULER_STATE_METADATA_KEY,
  SCHEDULER_STATE_STAGED,
} from '../runtime/scheduler.js';
import type { PlatformEvent } from '../runtime/types.js';
import {
  TaskboardValidationError,
  type TaskboardExecutionReconcileCandidate,
} from './types.js';
import {
  assertIntegrationExecutionMigrated,
  purposeForIntegrationAgentStatus,
} from './workflow/decider.js';

export const RECONCILIATION_GRACE_MS = 30_000;

export function isLegacyPendingTaskboardRun(run: RunRecord): boolean {
  return run.status === 'pending'
    && run.metadata?.taskboardExecution === true
    && run.metadata?.[SCHEDULER_STATE_METADATA_KEY] === undefined;
}

export function isStagedPendingRun(run: RunRecord): boolean {
  return run.status === 'pending'
    && run.metadata?.[SCHEDULER_STATE_METADATA_KEY] === SCHEDULER_STATE_STAGED;
}

export function assertExecutionSession(execution: TaskBoardExecution, sessionId: string): void {
  if (execution.sessionId !== sessionId) {
    throw new Error(`Runtime session 与任务看板 Execution 不匹配：run=${execution.runId}`);
  }
}

export function finalAssistantText(events: PlatformEvent[], runId: string, sessionId: string): string {
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

export function assertContinuationAllowed(task: TaskBoardTask, activeExecution?: TaskBoardExecution): void {
  assertIntegrationExecutionMigrated(task);
  if (task.status === 'done' || task.status === 'canceled' || task.mergedCommitOid) {
    throw new TaskboardValidationError(
      '已完成、已取消或已合并任务不能继续派发',
      'TASKBOARD_TERMINAL_EXECUTION_FORBIDDEN',
    );
  }
  if (task.status === 'blocked') {
    throw new TaskboardValidationError('阻塞任务需要显式恢复后才能继续', 'TASKBOARD_RESUME_REQUIRED');
  }
  if (task.kind === 'integration') {
    if (!activeExecution) throw new TaskboardValidationError('Integration Agent 由系统按 Agent 状态推进；当前没有可继续的执行，请仅发表评论', 'TASKBOARD_V3_COMMENT_CONTINUATION_REQUIRES_ACTIVE');
    if (!['work', 'review'].includes(activeExecution.purpose)) throw new TaskboardValidationError('Integration Agent 只能继续当前持久 Execution', 'TASKBOARD_INTEGRATION_PURPOSE_INVALID');
    return;
  }
  if (!['todo', 'in_review', 'in_progress'].includes(task.status)) {
    throw new TaskboardValidationError('当前任务状态不允许从评论创建新执行', 'TASKBOARD_EXECUTION_STATUS_INVALID');
  }
}

export function continuationPurpose(task: TaskBoardTask): TaskBoardExecutionPurpose {
  assertContinuationAllowed(task);

  if (task.kind === 'integration') {
    const purpose = purposeForIntegrationAgentStatus(task.status);
    if (purpose) return purpose;
  }
  if (task.status === 'in_review') return 'review';
  if (task.status === 'todo') return 'work';
  throw new TaskboardValidationError('当前任务状态不允许从评论创建新执行', 'TASKBOARD_EXECUTION_STATUS_INVALID');
}

export function matchesReconcileCandidate(
  run: RunRecord,
  candidate: TaskboardExecutionReconcileCandidate,
): boolean {
  return run.runId === candidate.runId
    && run.sessionId === candidate.sessionId
    && run.metadata?.taskboardExecution === true
    && run.metadata?.taskboardExecutionId === candidate.executionId;
}

export function isTerminalRunWithinGrace(run: RunRecord): boolean {
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

export function isTerminalRun(run: RunRecord): boolean {
  return run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'cancelled'
    || run.status === 'orphaned';
}

export function requireTenantId(tenantId: string | undefined): string {
  if (!tenantId?.trim()) throw new Error('Runtime event tenantId is required');
  return tenantId;
}

export function isTerminalExecution(execution: TaskBoardExecution): boolean {
  return execution.status === 'succeeded'
    || execution.status === 'failed'
    || execution.status === 'cancelled';
}
