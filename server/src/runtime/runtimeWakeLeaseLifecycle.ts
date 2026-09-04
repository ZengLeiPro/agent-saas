import type { RunStatus, RunStore } from './runStore.js';
import type { RunHeartbeatSource } from './runLiveness.js';
import { isTerminalRunStatus } from './wakeDispatchHelpers.js';

export { isTerminalRunStatus };
export const STEERING_RECOVERY_MAX_HANDOFFS = 3;
export const STEERING_RECOVERY_FAILURE_MESSAGE = '会话恢复连续失败，本次运行已结束，请重试。';

export interface RuntimeWakeLease {
  runId: string;
  workerId?: string;
  leaseToken?: string;
  renew(source?: RunHeartbeatSource): Promise<void>;
  handoff?(reason: string, metadataPatch?: Record<string, unknown>): Promise<void>;
  release(finalStatus?: RunStatus, reason?: string): Promise<void>;
}

export function startWakeLeaseRenewal(input: {
  lease?: RuntimeWakeLease;
  runStore?: RunStore;
  runId: string;
  abortController: AbortController;
  intervalMs: number;
}): NodeJS.Timeout | null {
  if (!input.lease) return null;
  let renewalInFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = (async () => {
      try {
        await input.lease?.renew('stream');
        if (!input.abortController.signal.aborted && input.runStore) {
          const current = await input.runStore.get(input.runId).catch(() => null);
          if (current?.status === 'cancelled') {
            clearInterval(timer);
            input.abortController.abort(new Error(current.statusReason ?? 'run_cancel_requested'));
          }
        }
      } catch (err) {
        const current = await input.runStore?.get(input.runId).catch(() => null);
        if (isTerminalRunStatus(current?.status)) {
          clearInterval(timer);
          return;
        }
        input.abortController.abort(err instanceof Error ? err : new Error(String(err)));
      }
    })().finally(() => {
      renewalInFlight = undefined;
    });
  }, input.intervalMs);
  timer.unref?.();
  return timer;
}
