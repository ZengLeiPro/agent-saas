import { randomUUID } from 'node:crypto';
import type { RunRecord, RunStore } from './runStore.js';

const DIRECT_RUNTIME_LEASE_MS = 120_000;
const DIRECT_RUNTIME_LEASE_RENEW_INTERVAL_MS = 30_000;

export interface DirectRuntimeLeaseHandle {
  workerId: string;
  release(): Promise<void>;
}

export class DirectRuntimeLeaseContendedError extends Error {
  constructor(readonly runId: string) {
    super(`Direct runtime lease not acquired run=${runId}`);
    this.name = 'DirectRuntimeLeaseContendedError';
  }
}

export class DirectRuntimeLeaseLostError extends Error {
  constructor(readonly runId: string, reason?: string) {
    super(`Direct runtime lease lost run=${runId}${reason ? `: ${reason}` : ''}`);
    this.name = 'DirectRuntimeLeaseLostError';
  }
}

export async function acquireDirectRuntimeRunLease(input: {
  runStore: RunStore | undefined;
  runId: string;
  tenantId?: string;
  sessionId?: string;
  runtimeWorkerId?: string;
  logger?: { warn(message: string): void };
  onLeaseLost?: (error: DirectRuntimeLeaseLostError) => void;
  renewIntervalMs?: number;
}): Promise<DirectRuntimeLeaseHandle | null> {
  if (input.runtimeWorkerId || !input.runStore) return null;
  if (!input.runStore.acquireLease) {
    throw new Error(`Direct runtime lease is unavailable run=${input.runId}`);
  }

  const workerId = `direct-${process.pid}-${randomUUID()}`;
  let acquired: RunRecord | null;
  try {
    acquired = await input.runStore.acquireLease(input.runId, workerId, DIRECT_RUNTIME_LEASE_MS, new Date(), undefined, undefined,
      input.tenantId && input.sessionId ? { tenantId: input.tenantId, sessionId: input.sessionId } : undefined);
  } catch (err) {
    input.logger?.warn(`Direct runtime lease acquire failed run=${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  if (!acquired) {
    const error = new DirectRuntimeLeaseContendedError(input.runId);
    input.logger?.warn(error.message);
    throw error;
  }
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let leaseLost = false;
  let released = false;
  const notifyLeaseLost = (reason?: string): void => {
    if (leaseLost || released) return;
    leaseLost = true;
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    const error = new DirectRuntimeLeaseLostError(input.runId, reason);
    input.logger?.warn(`${error.message} worker=${workerId}`);
    input.onLeaseLost?.(error);
  };
  if (input.runStore.renewLease) {
    let renewInFlight: Promise<void> | undefined;
    renewTimer = setInterval(() => {
      if (renewInFlight) return;
      renewInFlight = input.runStore!.renewLease!(input.runId, workerId, DIRECT_RUNTIME_LEASE_MS, new Date(), 'stream')
        .then((renewed) => {
          if (!renewed) notifyLeaseLost('renewal rejected');
        })
        .catch((err) => {
          notifyLeaseLost(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          renewInFlight = undefined;
        });
    }, input.renewIntervalMs ?? DIRECT_RUNTIME_LEASE_RENEW_INTERVAL_MS);
    renewTimer.unref?.();
  }

  return {
    workerId,
    async release() {
      released = true;
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
      await input.runStore?.releaseLease?.(input.runId, workerId).catch((err) => {
        input.logger?.warn(`Direct runtime lease release failed run=${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    },
  };
}
