const controllers = new Map<string, AbortController>();

export const runtimeRunController = {
  register(runId: string, controller: AbortController): void {
    controllers.set(runId, controller);
  },

  abort(runId: string, reason?: string): boolean {
    const controller = controllers.get(runId);
    if (!controller) return false;
    controller.abort(reason ? new Error(reason) : undefined);
    return true;
  },

  unregister(runId: string): void {
    controllers.delete(runId);
  },
};
