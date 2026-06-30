export class ActiveSandboxRegistry {
  private readonly entries = new Map<string, Set<string>>();

  acquire(sandboxName: string, key: string): () => void {
    const active = this.entries.get(sandboxName) ?? new Set<string>();
    active.add(key);
    this.entries.set(sandboxName, active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.entries.get(sandboxName);
      if (!current) return;
      current.delete(key);
      if (current.size === 0) this.entries.delete(sandboxName);
    };
  }

  isBusy(sandboxName: string, options: { exceptKey?: string } = {}): boolean {
    const active = this.entries.get(sandboxName);
    if (!active) return false;
    if (!options.exceptKey) return active.size > 0;
    for (const key of active) {
      if (key !== options.exceptKey) return true;
    }
    return false;
  }

  busyNames(): Set<string> {
    return new Set(this.entries.keys());
  }
}
