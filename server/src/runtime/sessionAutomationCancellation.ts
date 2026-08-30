import { finalizeTerminalRun } from './runTerminalCoordinator.js';

type FinalizeOptions = Parameters<typeof finalizeTerminalRun>[0];

export function createSessionAutomationCancelRun(input: {
  runStore: FinalizeOptions['runStore'];
  eventStore: FinalizeOptions['eventStore'];
  logger: FinalizeOptions['logger'];
  abort(runId: string, reason: string): void;
}): (runId: string, reason: string) => Promise<void> {
  return async (runId, reason) => {
    const before = await input.runStore.get(runId);
    if (!before) throw new Error(`automation cancellation run not found: ${runId}`);
    const result = await finalizeTerminalRun({
      runStore: input.runStore,
      eventStore: input.eventStore,
      runId,
      status: 'cancelled',
      reason,
      events: [{
        type: 'run_state_changed', runId, sessionId: before.sessionId,
        status: 'cancelled', previousStatus: before.status, reason,
      }],
      ...(before.tenantId ? { ctx: { tenantId: before.tenantId } } : {}),
      logger: input.logger,
      onClaim: () => input.abort(runId, reason),
    });
    if (result.won) return;
    if (!result.record || !['completed', 'failed', 'cancelled', 'orphaned'].includes(result.record.status)) {
      throw new Error(`automation cancellation did not reach a terminal run state: ${runId}`);
    }
    input.abort(runId, reason);
  };
}
