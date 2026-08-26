import type { PlatformEventInput } from './types.js';
import type { RunStatus } from './runStoreTypes.js';

/** Assemble every durable event written with a run cancellation transaction. */
export function buildRunCancellationEvents(
  requestedEvent: PlatformEventInput | undefined,
  appendRequestedEvent: boolean,
  toolEvents: PlatformEventInput[],
  sessionId: string,
  runId: string | undefined,
  cancelled: boolean,
  previousStatus: RunStatus | undefined,
  reason: string,
): PlatformEventInput[] {
  return [
    ...(appendRequestedEvent ? [requestedEvent!] : []),
    ...toolEvents,
    ...(!runId || !cancelled ? [] : [{
      type: 'run_state_changed' as const,
      sessionId,
      runId,
      status: 'cancelled' as const,
      ...(previousStatus ? { previousStatus } : {}),
      reason,
    }]),
  ];
}
