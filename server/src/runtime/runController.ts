interface RuntimeRunControllerEntry {
  controller: AbortController;
  abortOnDrain: boolean;
  userId?: string;
}

interface RuntimeRunControllerOptions {
  abortOnDrain?: boolean;
  userId?: string;
}

const controllers = new Map<string, RuntimeRunControllerEntry>();

export const runtimeRunController = {
  register(runId: string, controller: AbortController, options: RuntimeRunControllerOptions = {}): void {
    controllers.set(runId, {
      controller,
      abortOnDrain: options.abortOnDrain ?? true,
      userId: options.userId,
    });
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

  unregister(runId: string): void {
    controllers.delete(runId);
  },
};
