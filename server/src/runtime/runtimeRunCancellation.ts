import { runtimeRunController } from './runController.js';
import type { RunRecord, RunStore } from './runStore.js';

const PREEMPTING_TERMINAL_STATUSES = new Set(['completed', 'failed', 'orphaned'] as const);

type RuntimeCancellationRunStore = Pick<RunStore, 'get'>
  & Partial<Pick<RunStore, 'createPending' | 'cancelSteeringBeforeDispatchBySessionWithEvent'>>;

export type RuntimeCancellationOutcome =
  | { kind: 'cancelled'; run: RunRecord | null }
  | { kind: 'runtime_terminal'; run: RunRecord };

/**
 * Runtime canonical cancel：同事务取消目标/steering 并写 durable run_cancel_requested，
 * 随后中止本进程 controller。Cron、Taskboard 等父级调度器共用这一条收口路径。
 */
export async function cancelRuntimeRun(
  runStore: RuntimeCancellationRunStore,
  runId: string,
  reason: string,
  options: {
    missingIsCancelled?: boolean;
    reserveIfMissing?: Parameters<RunStore['upsertPending']>[0];
    abort?: (runId: string, reason: string) => unknown;
  } = {},
): Promise<RuntimeCancellationOutcome> {
  const abort = options.abort ?? ((id: string, abortReason: string) => runtimeRunController.abort(id, abortReason));
  let run = await runStore.get(runId);
  if (!run && options.reserveIfMissing) {
    if (!runStore.createPending) throw new Error('RunStore create-only reservation is unavailable');
    run = (await runStore.createPending(options.reserveIfMissing)).record;
  }
  if (!run) {
    if (options.missingIsCancelled) return { kind: 'cancelled', run: null };
    throw new Error(`Runtime Run 尚未落库，取消结果不确定：${runId}`);
  }
  if (run.status === 'cancelled') {
    abort(runId, reason);
    return { kind: 'cancelled', run };
  }
  if (PREEMPTING_TERMINAL_STATUSES.has(run.status as 'completed' | 'failed' | 'orphaned')) {
    return { kind: 'runtime_terminal', run };
  }

  const cancel = runStore.cancelSteeringBeforeDispatchBySessionWithEvent;
  if (!cancel) throw new Error('RunStore canonical cancellation service is unavailable');
  if (!run.tenantId) throw new Error(`Runtime Run tenant 缺失，拒绝取消：${runId}`);
  const result = await cancel.call(runStore, run.sessionId, reason, runId, {
    type: 'run_cancel_requested',
    sessionId: run.sessionId,
    runId,
    userId: run.userId,
    reason,
  }, run.tenantId);
  if (!result.targetCancelled) {
    const current = await runStore.get(runId);
    if (current?.status === 'cancelled') {
      abort(runId, reason);
      return { kind: 'cancelled', run: current };
    }
    if (current && PREEMPTING_TERMINAL_STATUSES.has(current.status as 'completed' | 'failed' | 'orphaned')) {
      return { kind: 'runtime_terminal', run: current };
    }
    throw new Error(`Runtime Run 取消 CAS 未命中：${runId} status=${current?.status ?? 'missing'}`);
  }
  abort(runId, reason);
  return { kind: 'cancelled', run: await runStore.get(runId) };
}

export function createCronRuntimeRunAdapters(
  runStore: RunStore,
  resolveTenantId: (userId: string) => string | undefined,
) {
  return {
    inspectRuntimeRun: (runtimeRunId: string) => runStore.get(runtimeRunId),
    cancelRuntimeRun: async (input: { runtimeRunId: string; sessionId: string; reason: string; tenantId?: string; userId?: string }) => {
      const tenantId = input.tenantId ?? (input.userId ? resolveTenantId(input.userId) : undefined);
      const options = tenantId ? { reserveIfMissing: {
        runId: input.runtimeRunId, sessionId: input.sessionId, tenantId, userId: input.userId,
        channel: 'cron', metadata: { cancellationReservation: true },
      } } : {};
      return (await cancelRuntimeRun(runStore, input.runtimeRunId, input.reason, options)).run;
    },
  };
}
