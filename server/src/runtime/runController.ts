import type { RuntimeDrainHandoffState } from '../agent/types.js';

interface RuntimeRunControllerEntry {
  controller: AbortController;
  abortOnDrain: boolean;
  drainHandoff?: RuntimeDrainHandoffState;
  userId?: string;
  tenantId?: string;
}

interface RuntimeRunControllerOptions {
  abortOnDrain?: boolean;
  drainHandoff?: RuntimeDrainHandoffState;
  userId?: string;
  tenantId?: string;
}

const controllers = new Map<string, RuntimeRunControllerEntry>();

export const runtimeRunController = {
  register(runId: string, controller: AbortController, options: RuntimeRunControllerOptions = {}): void {
    controllers.set(runId, {
      controller,
      abortOnDrain: options.abortOnDrain ?? true,
      drainHandoff: options.drainHandoff,
      userId: options.userId,
      tenantId: options.tenantId,
    });
  },

  requestAllForDrain(reason = 'server_drain_handoff'): number {
    let requested = 0;
    const requestedAt = new Date().toISOString();
    for (const entry of controllers.values()) {
      if (!entry.abortOnDrain || entry.controller.signal.aborted || !entry.drainHandoff) continue;
      if (entry.drainHandoff.requested) continue;
      entry.drainHandoff.requested = true;
      entry.drainHandoff.reason = reason;
      entry.drainHandoff.requestedAt = requestedAt;
      requested += 1;
    }
    return requested;
  },

  abort(runId: string, reason?: string): boolean {
    const entry = controllers.get(runId);
    if (!entry) return false;
    entry.controller.abort(reason ? new Error(reason) : undefined);
    return true;
  },

  abortAllForDrain(reason?: string): number {
    let aborted = 0;
    for (const entry of controllers.values()) {
      if (!entry.abortOnDrain || entry.controller.signal.aborted) continue;
      entry.controller.abort(reason ? new Error(reason) : undefined);
      aborted += 1;
    }
    return aborted;
  },

  abortByUser(userId: string, reason?: string): number {
    let aborted = 0;
    for (const entry of controllers.values()) {
      if (entry.userId !== userId || entry.controller.signal.aborted) continue;
      entry.controller.abort(reason ? new Error(reason) : undefined);
      aborted += 1;
    }
    return aborted;
  },

  abortByTenant(tenantId: string, reason?: string): number {
    let aborted = 0;
    for (const entry of controllers.values()) {
      if (entry.tenantId !== tenantId || entry.controller.signal.aborted) continue;
      entry.controller.abort(reason ? new Error(reason) : undefined);
      aborted += 1;
    }
    return aborted;
  },

  unregister(runId: string): void {
    controllers.delete(runId);
  },
};
