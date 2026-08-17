import type { RunRecord, RunStatus, RunStore } from '../runStore.js';

const ACTIVE_BACKGROUND_STATUSES = ['pending', 'running'] as const;

/** Never overwrites a terminal background-task state; PG uses a single-statement CAS. */
export async function markBackgroundTaskTerminal(
  runStore: RunStore,
  runId: string,
  status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>,
  reason?: string,
  metadataPatch: Record<string, unknown> = {},
): Promise<RunRecord | null> {
  if (runStore.markStatusIfCurrent) {
    return runStore.markStatusIfCurrent(
      runId,
      ACTIVE_BACKGROUND_STATUSES,
      status,
      reason,
      metadataPatch,
    );
  }
  const current = await runStore.get(runId);
  if (!current || !ACTIVE_BACKGROUND_STATUSES.includes(current.status as 'pending' | 'running')) return null;
  return runStore.markStatus(runId, status, reason, metadataPatch);
}
