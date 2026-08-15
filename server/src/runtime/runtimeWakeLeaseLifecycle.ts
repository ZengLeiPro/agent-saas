import type { RunStatus, RunStore } from './runStore.js';
import { isTerminalRunStatus } from './wakeDispatchHelpers.js';

export { isTerminalRunStatus };
export const STEERING_RECOVERY_MAX_HANDOFFS = 3;
export const STEERING_RECOVERY_FAILURE_MESSAGE = '会话恢复连续失败，本次运行已结束，请重试。';

export interface RuntimeWakeLease {
  runId: string;
  workerId?: string;
  renew(): Promise<void>;
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
  const timer = setInterval(() => {
    void (async () => {
      try {
        await input.lease?.renew();
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
    })();
  }, input.intervalMs);
  timer.unref?.();
  return timer;
}
