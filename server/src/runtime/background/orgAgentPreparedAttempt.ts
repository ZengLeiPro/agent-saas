import { runtimeRunController } from '../runController.js';
import type { RunRecord } from '../runStore.js';
import {
  createEventStoreForSession,
  resolveSessionCatalog,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import { markBackgroundTaskTerminal } from './backgroundTaskTerminal.js';
import { buildPausedAttemptContext } from './orgAgentContinuation.js';

export async function stopPreparedOrgAgentAttempt(
  config: RawRuntimeRunDispatchConfig,
  tenantId: string,
  workOrderId: string,
  sourceAttemptNo: number,
): Promise<RunRecord | null> {
  const store = config.orgGroupAgentStore!;
  const runStore = config.runStore!;
  const attempt = (await store.listWorkAttempts(tenantId, workOrderId)).find(
    (item) => item.attemptNo === sourceAttemptNo,
  );
  const task = attempt ? await runStore.get(attempt.runtimeRunId) : null;
  if (!task) return null;
  if (isTerminal(task.status)) {
    if (task.status === 'cancelled' && task.metadata.orgAgentAttemptSuperseded === true)
      return task;
    throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_TERMINAL_RACE');
  }
  const metadata = parseBackgroundTaskMetadata(task);
  if (!metadata?.workOrderId || metadata.workOrderId !== workOrderId)
    throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_SCOPE_INVALID');
  const catalog = resolveSessionCatalog(config);
  const taskSession = await catalog.get(task.sessionId);
  if (!taskSession) throw new Error(`后台任务 session 不存在：${task.sessionId}`);
  const result = {
    status: 'cancelled' as const,
    text: '组织群任务已暂停，恢复时会创建新 attempt',
    totalTokens: 0,
    toolUseCount: 0,
    turnCount: 0,
    durationMs: 0,
  };
  const stopped = await markBackgroundTaskTerminal(
    runStore,
    createEventStoreForSession(config, taskSession),
    task,
    'cancelled',
    '组织群任务已暂停',
    {
      backgroundResult: result,
      wakeState: 'pending',
      backgroundFinishedAt: new Date().toISOString(),
      orgAgentAttemptSuperseded: true,
      orgAgentPauseAttemptNo: sourceAttemptNo,
    },
  );
  if (!stopped) {
    const current = await runStore.get(task.runId);
    if (
      !current ||
      current.status !== 'cancelled' ||
      current.metadata.orgAgentAttemptSuperseded !== true
    )
      throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_RUN_CONFLICT');
  }
  const pausedContext = buildPausedAttemptContext(task.runId, metadata.cwd);
  const pausedAttempt = await store.transitionWorkAttempt({
    tenantId,
    runtimeRunId: task.runId,
    status: 'cancelled',
    resultEnvelope: pausedContext.resultEnvelope,
    checkpoint: pausedContext.checkpoint,
    publishState: 'rejected',
    failure: 'superseded_by_work_order_pause',
  });
  if (!pausedAttempt) {
    const existing = (await store.listWorkAttempts(tenantId, workOrderId)).find(
      (item) => item.runtimeRunId === task.runId,
    );
    if (!existing || existing.status !== 'cancelled')
      throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_CHECKPOINT_FAILED');
  }
  runtimeRunController.abort(task.runId);
  await catalog.markStatus(task.sessionId, 'error').catch(() => undefined);
  return stopped ?? task;
}

function isTerminal(status: RunRecord['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'orphaned'].includes(status);
}
