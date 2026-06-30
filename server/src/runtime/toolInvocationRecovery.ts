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
  const records = await options.toolInvocationStore.listRunning();
  let recovered = 0;
  const staleAfterMs = options.staleAfterMs;
  const now = Date.now();
  for (const record of records) {
    const run = await options.runStore?.get(record.runId).catch(() => null);
    const stale = typeof staleAfterMs === 'number' && now - new Date(record.updatedAt).getTime() >= staleAfterMs;
    const terminalRun = run && ['completed', 'failed', 'cancelled', 'orphaned'].includes(run.status);
    const activeLeasedRun = run?.status === 'running' && typeof run.leaseExpiresAt === 'string' && new Date(run.leaseExpiresAt).getTime() > now;
    if (activeLeasedRun || (!terminalRun && !stale)) continue;
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
