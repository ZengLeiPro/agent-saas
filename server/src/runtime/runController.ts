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

interface WallClockEntry {
  controller: AbortController;
  timer: NodeJS.Timeout;
  active: boolean;
}

export const DEFAULT_FOREGROUND_RUN_MAX_WALL_CLOCK_MS = 6 * 60 * 60 * 1000;
const wallClockTimers = new Map<string, WallClockEntry>();

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

  armWallClock(
    runId: string,
    controller: AbortController,
    options: {
      maxWallClockMs?: number;
      shouldAbort?: () => boolean | Promise<boolean>;
      reason?: string;
    } = {},
  ): void {
    this.disarmWallClock(runId);
    const maxWallClockMs = Math.max(1_000, Math.floor(
      options.maxWallClockMs ?? DEFAULT_FOREGROUND_RUN_MAX_WALL_CLOCK_MS,
    ));
    const entry = {} as WallClockEntry;
    entry.controller = controller;
    entry.active = true;
    entry.timer = setTimeout(() => {
      // shouldAbort 可能访问持久层；期间 run 可正常完成、进入等待态，或被同 runId
      // 的恢复段重新 arm。只有当前 generation 仍有效时才允许发出 abort。
      void (async () => {
        try {
          const shouldAbort = await (options.shouldAbort?.() ?? true);
          if (
            shouldAbort
            && entry.active
            && wallClockTimers.get(runId) === entry
            && !controller.signal.aborted
          ) {
            controller.abort(new Error(options.reason ?? 'run_max_wall_clock_exceeded'));
          }
        } catch {
          // 墙钟判定失败不能形成 unhandled rejection，也不能在状态未知时误杀 run。
        } finally {
          if (wallClockTimers.get(runId) === entry) wallClockTimers.delete(runId);
          entry.active = false;
        }
      })();
    }, maxWallClockMs);
    entry.timer.unref?.();
    wallClockTimers.set(runId, entry);
  },

  disarmWallClock(runId: string): void {
    const entry = wallClockTimers.get(runId);
    if (entry) {
      entry.active = false;
      clearTimeout(entry.timer);
    }
    wallClockTimers.delete(runId);
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
    this.disarmWallClock(runId);
    controllers.delete(runId);
  },
};
