import { finalizeTerminalRun } from '../runTerminalCoordinator.js';
import type { RunLeaseAuthority, RunRecord, RunStatus, RunStore } from '../runStore.js';
import type { EventStore } from '../types.js';

const ACTIVE_BACKGROUND_STATUSES = ['pending', 'running'] as const;

/**
 * Terminalizes a background task through the same durable state/outbox CAS as foreground runs.
 * Event append may fail, but the durable outbox is committed before this function returns.
 */
export async function markBackgroundTaskTerminal(
  runStore: RunStore,
  eventStore: EventStore,
  run: RunRecord,
  status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>,
  reason?: string,
  metadataPatch: Record<string, unknown> = {},
  leaseAuthority?: RunLeaseAuthority,
): Promise<RunRecord | null> {
  const tenantId = run.tenantId?.trim();
  if (!tenantId) throw new Error(`background terminal tenantId missing: ${run.runId}`);
  const terminalPatch = leaseAuthority ? { ...metadataPatch,
    backgroundTerminalWorkerId: leaseAuthority.workerId,
    backgroundTerminalLeaseToken: leaseAuthority.leaseToken } : metadataPatch;
  const result = await finalizeTerminalRun({
    runStore,
    eventStore,
    runId: run.runId,
    status,
    reason,
    expectedStatuses: ACTIVE_BACKGROUND_STATUSES,
    claim: (outboxPatch) => runStore.markStatusIfCurrent
      ? runStore.markStatusIfCurrent(
          run.runId,
          ACTIVE_BACKGROUND_STATUSES,
          status,
          reason,
          { ...terminalPatch, ...outboxPatch },
          leaseAuthority,
        )
      : leaseAuthority ? Promise.resolve(null)
        : runStore.markStatus(run.runId, status, reason, { ...terminalPatch, ...outboxPatch }),
    events: [{
      type: 'run_state_changed',
      runId: run.runId,
      sessionId: run.sessionId,
      status,
      previousStatus: run.status,
      ...(reason ? { reason } : {}),
    }],
    ctx: { tenantId },
  });
  return result.won ? result.record : null;
}
