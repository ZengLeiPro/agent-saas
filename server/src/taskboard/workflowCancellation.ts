import type { RunStore } from '../runtime/runStore.js';
import { cancelRuntimeRun } from '../runtime/runtimeRunCancellation.js';
import type {
  TaskboardExecutionStore,
  TaskboardRuntimeTerminalFact,
  TaskboardWorkflowCancellation,
} from './types.js';

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
  // Taskboard 已先用 Execution fencing 阻止 Runtime 创建，因此 missing 可视为取消完成。
  const outcome = await cancelRuntimeRun(runStore, runId, reason, { missingIsCancelled: true });
  if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
  return {
    kind: 'runtime_terminal',
    fact: {
      runId,
      status: outcome.run.status as 'completed' | 'failed' | 'orphaned',
      ...(outcome.run.statusReason ? { reason: outcome.run.statusReason } : {}),
    },
  };
}
