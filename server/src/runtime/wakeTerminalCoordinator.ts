import type { RunRecord, RunStatus, RunStore } from './runStore.js';
import {
  appendRunStateChanged,
  finalizeTerminalRun,
  readTerminalEventOutbox,
  type TerminalEventLogger,
} from './runTerminalCoordinator.js';
import type { EventStore } from './types.js';
import { isTerminalRunStatus, type RuntimeWakeLease } from './runtimeWakeLeaseLifecycle.js';

type TerminalStatus = Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'orphaned'>;

/** Finish a dispatched wake through the durable terminal path when terminal. */
export async function releaseWakeLeaseAfterDispatch(input: {
  config: { runStore?: RunStore; logger?: TerminalEventLogger };
  eventStore: EventStore;
  run: RunRecord;
  lease?: RuntimeWakeLease;
  defaultReason: string;
}): Promise<void> {
  const current = await input.config.runStore?.get(input.run.runId);
  const reason = current?.statusReason ?? input.defaultReason;
  if (current && isTerminalRunStatus(current.status)) {
    await finalizeWakeTerminalRun({ ...input, status: current.status as TerminalStatus, reason });
  } else if (current) await input.lease?.release(current.status, reason);
}

/** Durable terminal claim/event publication must precede lease release on every wake path. */
export async function finalizeWakeTerminalRun(input: {
  config: { runStore?: RunStore; logger?: TerminalEventLogger };
  eventStore: EventStore;
  run: RunRecord;
  status: TerminalStatus;
  reason: string;
  lease?: RuntimeWakeLease;
}): Promise<void> {
  const current = await input.config.runStore?.get(input.run.runId);
  const tenantId = current?.tenantId ?? input.run.tenantId;
  if (!tenantId) throw new Error(`wake terminal tenantId missing: ${input.run.runId}`);
  if (input.config.runStore) {
    const mayRepairStateOnlyTerminal = current?.status === input.status && !readTerminalEventOutbox(current);
    if (!isTerminalRunStatus(current?.status) || mayRepairStateOnlyTerminal) {
      await finalizeTerminalRun({
        runStore: input.config.runStore, eventStore: input.eventStore,
        runId: input.run.runId, status: input.status, reason: input.reason,
        ...(mayRepairStateOnlyTerminal
          ? { expectedStatuses: [input.status], stateOnlyRepair: true }
          : {}),
        events: [{
          type: 'run_state_changed', runId: input.run.runId, sessionId: input.run.sessionId, status: input.status,
          ...(!isTerminalRunStatus(current?.status) && current?.status ? { previousStatus: current.status } : {}),
          reason: input.reason,
        }],
        ctx: { tenantId }, logger: input.config.logger,
      });
    }
    await input.lease?.release(undefined, input.reason);
    return;
  }
  await appendRunStateChanged(
    input.eventStore, input.run.sessionId, input.run.runId, input.status,
    input.run.status, input.reason, { tenantId },
  );
  await input.lease?.release(input.status, input.reason);
}
