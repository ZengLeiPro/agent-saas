export interface ExternalApiAdmissionDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: 'rate_limit' | 'concurrency_limit';
  release?: () => void;
}

interface WindowState {
  startedAt: number;
  requests: number;
}

/**
 * Per-process abuse guard. Durable business budgets remain enforced by the
 * service-account billing policy; this guard protects the public HTTP edge.
 */
export class ExternalApiAdmissionController {
  private readonly windows = new Map<string, WindowState>();
  private readonly active = new Map<string, number>();

  constructor(
    private readonly options: {
      maxRequestsPerMinute?: number;
      maxConcurrentRequests?: number;
      now?: () => number;
    } = {},
  ) {}

  check(clientId: string): ExternalApiAdmissionDecision {
    const now = this.options.now?.() ?? Date.now();
    const limit = Math.max(1, this.options.maxRequestsPerMinute ?? 60);
    const current = this.windows.get(clientId);
    if (!current || now - current.startedAt >= 60_000) {
      this.windows.set(clientId, { startedAt: now, requests: 1 });
      return { allowed: true };
    }
    if (current.requests >= limit) {
      return {
        allowed: false,
        reason: 'rate_limit',
        retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - current.startedAt)) / 1_000)),
      };
    }
    current.requests += 1;
    return { allowed: true };
  }

  acquire(clientId: string): ExternalApiAdmissionDecision {
    const rate = this.check(clientId);
    if (!rate.allowed) return rate;
    const active = this.active.get(clientId) ?? 0;
    const limit = Math.max(1, this.options.maxConcurrentRequests ?? 8);
    if (active >= limit)
      return { allowed: false, reason: 'concurrency_limit', retryAfterSeconds: 1 };
    this.active.set(clientId, active + 1);
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        const next = Math.max(0, (this.active.get(clientId) ?? 1) - 1);
        if (next === 0) this.active.delete(clientId);
        else this.active.set(clientId, next);
      },
    };
  }
}
