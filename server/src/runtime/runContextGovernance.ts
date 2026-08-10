import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { RunContext } from './types.js';
import type { RunStore } from './runStore.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned']);

export function resolveRunTenantId(context: RunContext): string {
  return context.tenantId
    ?? context.channelContext.sessionOwner?.tenantId
    ?? context.channelContext.user?.tenantId
    ?? DEFAULT_TENANT_ID;
}

export function withDurableRunCancellation(context: RunContext, runStore?: RunStore): RunContext {
  if (!runStore) return context;
  const durableCancellation = new AbortController();
  const watchedContext = {
    ...context,
    signal: context.signal
      ? AbortSignal.any([context.signal, durableCancellation.signal])
      : durableCancellation.signal,
  };
  let checking = false;
  let timer: NodeJS.Timeout | undefined;
  const check = async () => {
    if (checking || durableCancellation.signal.aborted) return;
    checking = true;
    try {
      const run = await runStore.get(context.runId);
      if (run?.status === 'cancelled') {
        durableCancellation.abort(new Error(run.statusReason ?? 'run cancelled'));
      }
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        if (timer) clearInterval(timer);
      }
    } catch {
      // Transient control-plane reads do not abort a healthy run; the next poll retries.
    } finally {
      checking = false;
    }
  };
  timer = setInterval(() => void check(), 500);
  timer.unref?.();
  void check();
  return watchedContext;
}
