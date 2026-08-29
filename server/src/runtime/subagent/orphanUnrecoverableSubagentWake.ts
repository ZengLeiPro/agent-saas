import type { RunStore } from '../runStore.js';
import { markRunState, type TerminalEventLogger } from '../runTerminalCoordinator.js';
import type { SessionCatalog } from '../sessionCatalog.js';
import type { EventStore } from '../types.js';
import { isTerminalRunStatus, type RuntimeWakeLease } from '../runtimeWakeLeaseLifecycle.js';

/**
 * 子 Agent run 守卫采用父死子亡语义，绝不允许 scheduler 恢复重放；
 * 重放会产生双份模型执行与双份计费。
 *
 * lease 会让 listRecoverable 跳过执行中的子 run；这里只兜底进程崩溃后
 * lease 过期的残留。子 Agent 不允许重放，run 与 hidden session 必须一起落终态。
 */
export async function orphanUnrecoverableSubagentWake(input: {
  runStore?: RunStore;
  eventStore: EventStore;
  sessionCatalog: SessionCatalog;
  lease?: RuntimeWakeLease;
  sessionId: string;
  runId: string;
  tenantId: string;
  logger?: TerminalEventLogger;
}): Promise<void> {
  await input.lease?.release('orphaned', 'subagent_run_not_recoverable');
  await markRunState(
    input.runStore,
    input.eventStore,
    input.sessionId,
    input.runId,
    'orphaned',
    'subagent_run_not_recoverable',
    input.logger,
    { tenantId: input.tenantId },
  ).catch(() => undefined);

  const durableRun = await input.runStore?.get(input.runId).catch(() => null);
  if (input.runStore && !isTerminalRunStatus(durableRun?.status)) return;
  await input.sessionCatalog
    .markStatus(input.sessionId, durableRun?.status === 'completed' ? 'finished' : 'error')
    .catch((error) =>
      input.logger?.warn(
        `[subagent-wake] failed to close hidden session=${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}
