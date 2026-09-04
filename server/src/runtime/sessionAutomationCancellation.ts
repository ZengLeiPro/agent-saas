import { cancelRuntimeRun } from './runtimeRunCancellation.js';
import type { RunStore } from './runStore.js';

export function createSessionAutomationCancelRun(input: {
  runStore: RunStore;
  eventStore: unknown;
  logger?: unknown;
  abort(runId: string, reason: string): void;
}): (runId: string, reason: string) => Promise<void> {
  return async (runId, reason) => {
    const outcome = await cancelRuntimeRun(input.runStore, runId, reason, { abort: input.abort });
    if (outcome.kind === 'runtime_terminal') return;
    if (outcome.run && outcome.run.status !== 'cancelled') {
      throw new Error(`automation cancellation did not reach a terminal run state: ${runId}`);
    }
  };
}
