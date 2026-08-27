import { runtimeRunController } from '../runtime/runController.js';
import type { RunStore } from '../runtime/runStore.js';
import type {
  TaskboardExecutionStore,
  TaskboardRuntimeTerminalFact,
  TaskboardWorkflowCancellation,
} from './types.js';

const PREEMPTING_TERMINAL_STATUSES = new Set(['completed', 'failed', 'orphaned'] as const);

export type WorkflowCancellationOutcome =
  | { kind: 'cancelled' }
  | { kind: 'runtime_terminal'; fact: TaskboardRuntimeTerminalFact };

type WorkflowCancellationRunStore = Pick<RunStore, 'get'>
  & Partial<Pick<RunStore, 'cancelSteeringBeforeDispatchBySessionWithEvent'>>;

export async function consumeTaskboardWorkflowCancellation(
  runStore: WorkflowCancellationRunStore,
  store: TaskboardExecutionStore,
  cancellation: TaskboardWorkflowCancellation,
): Promise<void> {
  const outcome = await cancelTaskboardWorkflowRun(runStore, cancellation.runId, cancellation.reason);
  if (outcome.kind === 'runtime_terminal') {
    const reconcileTerminal = store.reconcileWorkflowCancellationTerminal;
    if (!reconcileTerminal) throw new Error('Taskboard terminal cancellation reconciliation is unavailable');
    await reconcileTerminal.call(store, cancellation.id, outcome.fact);
    return;
  }
  await store.finishWorkflowCancellation?.(cancellation.id);
}

export async function cancelTaskboardWorkflowRun(
  runStore: WorkflowCancellationRunStore,
  runId: string,
  reason: string,
): Promise<WorkflowCancellationOutcome> {
  const run = await runStore.get(runId);
  // Workflow fencing locks the Execution row against Runtime creation before enqueuing cancellation.
  // If no Run exists after that fence commits, dispatch is no longer admissible and cancellation is complete.
  if (!run) return { kind: 'cancelled' };
  if (run.status === 'cancelled') {
    runtimeRunController.abort(runId, reason);
    return { kind: 'cancelled' };
  }
  if (PREEMPTING_TERMINAL_STATUSES.has(run.status as 'completed' | 'failed' | 'orphaned')) {
    return {
      kind: 'runtime_terminal',
      fact: {
        runId,
        status: run.status as 'completed' | 'failed' | 'orphaned',
        ...(run.statusReason ? { reason: run.statusReason } : {}),
      },
    };
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
      if (current && PREEMPTING_TERMINAL_STATUSES.has(current.status as 'completed' | 'failed' | 'orphaned')) {
        return {
          kind: 'runtime_terminal',
          fact: {
            runId,
            status: current.status as 'completed' | 'failed' | 'orphaned',
            ...(current.statusReason ? { reason: current.statusReason } : {}),
          },
        };
      }
      throw new Error(`Runtime Run 取消 CAS 未命中，保留 cancellation outbox：${runId} status=${current?.status ?? 'missing'}`);
    }
  }
  runtimeRunController.abort(runId, reason);
  return { kind: 'cancelled' };
}
