/** Retained after unregister: disappearing from memory is not durable completion evidence. */
export class RetirementInventory {
  private readonly runs = new Map<string, { workerId: string | null; tenantId: string | null }>();
  private complete = true;
  constructor(private readonly limit = 10_000) {}
  add(runId: string, workerId?: string, tenantId?: string): void {
    if (
      !runId ||
      runId.length > 256 ||
      (workerId?.length ?? 0) > 256 ||
      (tenantId?.length ?? 0) > 256
    ) {
      this.complete = false;
      return;
    }
    const owner = { workerId: workerId || null, tenantId: tenantId || null };
    const previous = this.runs.get(runId);
    if (previous) {
      if (previous.workerId !== owner.workerId || previous.tenantId !== owner.tenantId)
        this.complete = false;
      return;
    }
    if (this.runs.size >= this.limit) {
      this.complete = false;
      return;
    }
    this.runs.set(runId, owner);
  }
  snapshot(): {
    inventoryComplete: boolean;
    drainRuns: Array<{ runId: string; workerId: string | null; tenantId: string | null }>;
  } {
    return {
      inventoryComplete: this.complete,
      drainRuns: [...this.runs].map(([runId, owner]) => ({ runId, ...owner })),
    };
  }
}
