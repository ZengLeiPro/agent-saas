import type { RunRecord, RunStore } from './runStore.js';
import { markRunState } from './runTerminalCoordinator.js';
import type { RuntimeSessionRecord, SessionCatalog } from './sessionCatalog.js';
import type { EventStore } from './types.js';
import type { RuntimeWakeLease } from './runtimeWakeLeaseLifecycle.js';

interface ReplayIdentity {
  id?: string;
  tenantId?: string;
}

export async function resolveMemoryConsolidationReplaySource(
  sessionCatalog: SessionCatalog,
  sourceSessionId: string | undefined,
  identity: ReplayIdentity | undefined,
): Promise<{ session: RuntimeSessionRecord | null; error?: string }> {
  if (!sourceSessionId) return { session: null };
  const session = await sessionCatalog.get(sourceSessionId);
  if (!session) return { session: null, error: `记忆审查父会话不存在：${sourceSessionId}` };
  if (session.status === 'running') {
    return { session: null, error: `记忆审查父会话仍在运行：${session.sessionId}` };
  }
  if (session.userId !== identity?.id || session.tenantId !== identity?.tenantId) {
    return { session: null, error: '记忆审查父会话与当前用户身份不一致' };
  }
  return { session };
}

export async function rejectMemoryConsolidationWake(options: {
  run: RunRecord;
  lease?: RuntimeWakeLease;
  runStore?: RunStore;
  eventStore: EventStore;
  sessionCatalog: SessionCatalog;
}): Promise<boolean> {
  const { run } = options;
  if (typeof run.metadata?.memoryConsolidationSourceSessionId !== 'string') return false;
  const reason = 'memory_consolidation_run_not_recoverable';
  let coordinated = false;
  await markRunState(
    options.runStore,
    options.eventStore,
    run.sessionId,
    run.runId,
    'failed',
    reason,
  ).then(() => { coordinated = true; }).catch(() => undefined);
  await options.lease?.release(coordinated ? undefined : 'failed', reason);
  await options.sessionCatalog.markStatus(run.sessionId, 'error').catch(() => undefined);
  return true;
}
