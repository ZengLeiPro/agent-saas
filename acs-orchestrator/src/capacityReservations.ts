import { addUsage, zeroUsage, type SandboxResourceUsage } from './sandboxCapacity.js';

export class CapacityReservations {
  private gate: Promise<void> = Promise.resolve();
  private readonly reservations = new Map<string, SandboxResourceUsage>();

  async reserve(name: string, usage: SandboxResourceUsage, check: () => Promise<void>): Promise<void> {
    let unlock!: () => void;
    const predecessor = this.gate;
    this.gate = new Promise<void>((resolve) => { unlock = resolve; });
    await predecessor;
    try {
      await check();
      this.reservations.set(name, usage);
    } finally {
      unlock();
    }
  }

  release(name: string): void {
    this.reservations.delete(name);
  }

  pendingUsage(existingNames: Set<string>, currentName: string): SandboxResourceUsage {
    let pending = zeroUsage();
    for (const [name, usage] of this.reservations) {
      if (name !== currentName && !existingNames.has(name)) pending = addUsage(pending, usage);
    }
    return pending;
  }
}
