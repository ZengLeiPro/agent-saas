import { createHash } from 'node:crypto';

export interface PreparedBrokeredWarmup<TManager> {
  manager: TManager;
  fingerprint: string;
  identity: string;
}

interface BrokeredWarmupFailure {
  attempts: number;
  nextRetryAt: number;
  error: unknown;
}

export function digestBrokeredWarmup(value: unknown): string {
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined');
  return createHash('sha256').update(serialized).digest('hex');
}

/** Single-flight and retry circuit for one-shot brokered MCP list-tools warmups. */
export class BrokeredWarmupCoordinator<TManager, TResult> {
  private readonly inflight = new Map<string, Promise<TResult>>();
  private readonly failures = new Map<string, BrokeredWarmupFailure>();
  private readonly fingerprintByIdentity = new Map<string, string>();

  constructor(private readonly retryDelaysMs: readonly number[]) {}

  run(
    prepared: PreparedBrokeredWarmup<TManager>,
    execute: (manager: TManager) => Promise<TResult>,
  ): Promise<TResult> {
    // Always re-read config before consulting the circuit. A credential rotation
    // or server config edit changes the fingerprint and immediately recovers.
    const previousFingerprint = this.fingerprintByIdentity.get(prepared.identity);
    if (previousFingerprint && previousFingerprint !== prepared.fingerprint) {
      this.failures.delete(previousFingerprint);
    }
    this.fingerprintByIdentity.set(prepared.identity, prepared.fingerprint);

    const failure = this.failures.get(prepared.fingerprint);
    if (failure && failure.nextRetryAt > Date.now()) return Promise.reject(failure.error);

    const existing = this.inflight.get(prepared.fingerprint);
    if (existing) return existing;

    const pending = execute(prepared.manager)
      .then(result => {
        this.failures.delete(prepared.fingerprint);
        return result;
      })
      .catch(error => {
        // Do not retain stale failures after credentials/config have changed.
        if (this.fingerprintByIdentity.get(prepared.identity) === prepared.fingerprint) {
          const previous = this.failures.get(prepared.fingerprint);
          const attempts = (previous?.attempts ?? 0) + 1;
          const delay = this.retryDelaysMs[Math.min(attempts - 1, this.retryDelaysMs.length - 1)];
          this.failures.set(prepared.fingerprint, {
            attempts,
            nextRetryAt: Date.now() + delay,
            error,
          });
        }
        throw error;
      })
      .finally(() => {
        this.inflight.delete(prepared.fingerprint);
      });
    this.inflight.set(prepared.fingerprint, pending);
    return pending;
  }

  clear(): void {
    this.inflight.clear();
    this.failures.clear();
    this.fingerprintByIdentity.clear();
  }
}
