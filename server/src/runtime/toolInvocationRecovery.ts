import type { EventStore } from './types.js';
import type { RunStore } from './runStore.js';
import type { ToolInvocationStore } from './toolInvocationStore.js';

export interface RecoverRunningToolInvocationsOptions {
  toolInvocationStore: ToolInvocationStore;
  eventStore: EventStore;
  runStore?: RunStore;
  staleAfterMs?: number;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

export async function recoverRunningToolInvocations(options: RecoverRunningToolInvocationsOptions): Promise<{ scanned: number; recovered: number }> {
  const running = await options.toolInvocationStore.listRunning();
  const cancelRecoveryCandidates = options.runStore
    ? await options.toolInvocationStore.listCancelRecoveryCandidates?.() ?? []
    : [];
  const records = [...new Map(
    [...running, ...cancelRecoveryCandidates].map((record) => [record.invocationId, record]),
  ).values()];
  let recovered = 0;
  const staleAfterMs = options.staleAfterMs;
  const now = Date.now();
  for (const record of records) {
    const run = await options.runStore?.get(record.runId).catch(() => null);
    const stale = typeof staleAfterMs === 'number' && now - new Date(record.updatedAt).getTime() >= staleAfterMs;
    const terminalRun = run && ['completed', 'failed', 'cancelled', 'orphaned'].includes(run.status);
    const activeLeasedRun = run?.status === 'running' && typeof run.leaseExpiresAt === 'string' && new Date(run.leaseExpiresAt).getTime() > now;
    const completedBeforeCancellation = run?.status === 'cancelled'
      && record.completedAt
      && run.cancelledAt
      && new Date(record.completedAt).getTime() < new Date(run.cancelledAt).getTime();
    const terminalNeedsCancelRepair = record.status !== 'running'
      && record.completedAt
      && run?.cancelledAt
      && new Date(record.completedAt).getTime() >= new Date(run.cancelledAt).getTime();
    if (activeLeasedRun || completedBeforeCancellation || (!terminalRun && !stale)) continue;
    if (
      run?.status === 'cancelled'
      && run.cancelledAt
      && !record.cancelRequestedAt
      && (record.status === 'running' || terminalNeedsCancelRepair)
    ) {
      // record 是扫描快照；登记时必须针对 invocation 当前状态重新做时间谓词 CAS。
      // 否则 invocation 在快照后先完成、run 随后取消时，会误建外部取消 outbox。
      const cancelRequest = await options.toolInvocationStore.requestCancelOnceAfterRunCancellation(
        record.invocationId,
        run.cancelledAt,
        'recovered_after_cancelled_run',
        { cancelRecovery: 'terminal_run' },
      );
      if (cancelRequest?.created) {
        await options.eventStore.append({
          type: 'tool_invocation_cancel_requested',
          runId: record.runId,
          sessionId: record.sessionId,
          invocationId: record.invocationId,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          reason: 'recovered_after_cancelled_run',
          metadata: cancelRequest.record.metadata,
        });
      }
    }
    // 已终态 invocation 只补 durable cancel outbox，保留原执行结果；running 才需要恢复收尾。
    if (record.status !== 'running') continue;
    const error = terminalRun
      ? `tool invocation recovered after terminal run status=${run.status}`
      : `tool invocation recovered as stale after ${staleAfterMs}ms`;
    const completed = await options.toolInvocationStore.complete(record.invocationId, 'failed', error);
    if (!completed) continue;
    recovered += 1;
    await options.eventStore.append({
      type: 'tool_invocation_completed',
      runId: record.runId,
      sessionId: record.sessionId,
      invocationId: record.invocationId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      status: 'error',
      durationMs: Math.max(0, now - new Date(record.startedAt).getTime()),
      error,
    });
  }
  options.logger?.info?.(`ToolInvocationRecovery scanned=${records.length} recovered=${recovered}`);
  return { scanned: records.length, recovered };
}
