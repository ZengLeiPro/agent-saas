export class CapacityReservations {
  private gate: Promise<void> = Promise.resolve();
  private readonly names = new Set<string>();

  async reserve(name: string, check: () => Promise<void>): Promise<void> {
    let unlock!: () => void;
    const predecessor = this.gate;
    this.gate = new Promise<void>((resolve) => { unlock = resolve; });
    await predecessor;
    try {
      await check();
      this.names.add(name);
    } finally {
      unlock();
    }
  }

  release(name: string): void {
    this.names.delete(name);
  }

  occupiedCount(activeNames: Set<string>, currentName: string): number {
    let pending = 0;
    for (const name of this.names) {
      if (name !== currentName && !activeNames.has(name)) pending += 1;
    }
    return activeNames.size + pending;
  }
}
