import { runtimeRunController } from '../runtime/runController.js';
import type { RunStore } from '../runtime/runStore.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned']);

type WorkflowCancellationRunStore = Pick<RunStore, 'get'>
  & Partial<Pick<RunStore, 'cancelSteeringBeforeDispatchBySessionWithEvent'>>;

export async function cancelTaskboardWorkflowRun(
  runStore: WorkflowCancellationRunStore,
  runId: string,
  reason: string,
): Promise<void> {
  const run = await runStore.get(runId);
  if (!run) throw new Error(`Runtime Run 尚未创建，保留 cancellation outbox：${runId}`);
  if (run.status === 'cancelled') {
    runtimeRunController.abort(runId, reason);
    return;
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new Error(`Runtime Run 已并发终态化，取消未生效：${runId} status=${run.status}`);
  }
  const cancel = runStore.cancelSteeringBeforeDispatchBySessionWithEvent;
  if (!cancel) throw new Error('RunStore canonical cancellation service is unavailable');
  if (!run.tenantId) throw new Error(`Runtime Run tenant 缺失，拒绝取消：${runId}`);
  const result = await cancel.call(runStore, run.sessionId, reason, runId, {
    type: 'run_cancel_requested', sessionId: run.sessionId, runId, userId: run.userId, reason,
  }, run.tenantId);
  if (!result.targetCancelled) {
    const current = await runStore.get(runId);
    if (current?.status !== 'cancelled') {
      throw new Error(`Runtime Run 取消 CAS 未命中，保留 cancellation outbox：${runId} status=${current?.status ?? 'missing'}`);
    }
  }
  runtimeRunController.abort(runId, reason);
}
