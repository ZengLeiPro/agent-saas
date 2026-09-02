/** M50-05 idempotency and network-generation fence for read-only recovery requests. */

export interface LifecycleRecoveryRequest {
  requestId: string;
  networkGeneration: number;
}

export type LifecycleRecoveryAdmission<T> =
  | { status: 'fresh' }
  | { status: 'duplicate'; response?: T }
  | { status: 'stale_generation'; latestNetworkGeneration: number };

interface LedgerEntry<T> {
  networkGeneration: number;
  response?: T;
  createdAt: number;
}

export class LifecycleRecoveryRequestLedger<T = unknown> {
  private latestNetworkGeneration = -1;
  private readonly entries = new Map<string, LedgerEntry<T>>();

  constructor(private readonly maxEntries = 256) {}

  admit(request: LifecycleRecoveryRequest, nowMs = Date.now()): LifecycleRecoveryAdmission<T> {
    if (!request.requestId || !Number.isSafeInteger(request.networkGeneration) || request.networkGeneration < 0) {
      return { status: 'stale_generation', latestNetworkGeneration: Math.max(0, this.latestNetworkGeneration) };
    }
    if (request.networkGeneration < this.latestNetworkGeneration) {
      return { status: 'stale_generation', latestNetworkGeneration: this.latestNetworkGeneration };
    }
    if (request.networkGeneration > this.latestNetworkGeneration) {
      this.latestNetworkGeneration = request.networkGeneration;
      for (const [id, entry] of this.entries) {
        if (entry.networkGeneration < request.networkGeneration) this.entries.delete(id);
      }
    }
    const existing = this.entries.get(request.requestId);
    if (existing) return { status: 'duplicate', ...(existing.response !== undefined ? { response: existing.response } : {}) };
    this.entries.set(request.requestId, { networkGeneration: request.networkGeneration, createdAt: nowMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return { status: 'fresh' };
  }

  complete(request: LifecycleRecoveryRequest, response: T): void {
    const existing = this.entries.get(request.requestId);
    if (!existing || existing.networkGeneration !== request.networkGeneration) return;
    this.entries.set(request.requestId, { ...existing, response });
  }

  clear(): void {
    this.entries.clear();
    this.latestNetworkGeneration = -1;
  }
}
