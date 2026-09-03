export const ACTIVE_INVOCATION_LEASE_MS = 2 * 60_000;
export const ACTIVE_INVOCATION_LEASE_RENEW_MS = 60_000;
const LEASE_FAIL_CLOSED_MARGIN_MS = 5_000;

export class InvocationLeaseMonitor {
  private renewal: Promise<void> | undefined;
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private failureValue: Error | undefined;
  private leaseFailAtMs: number | undefined;
  private failureResolve!: () => void;
  private readonly failureSignal = new Promise<void>((resolve) => { this.failureResolve = resolve; });
  private finishing = false;
  private closed = false;

  constructor(
    private readonly renewLease: (leaseUntil: string) => Promise<void>,
    private readonly onFailure: (error: Error) => void,
  ) {}

  start(leaseUntilMs: number): void {
    if (leaseUntilMs - LEASE_FAIL_CLOSED_MARGIN_MS <= Date.now()) {
      this.fail(new Error('persisted invocation lease expired before runner start'));
      return;
    }
    this.armExpiry(leaseUntilMs);
    this.renewTimer = setInterval(() => this.renew(), ACTIVE_INVOCATION_LEASE_RENEW_MS);
    this.renewTimer.unref?.();
  }

  get failure(): Error | undefined {
    return this.failureValue;
  }

  async finish(): Promise<Error | undefined> {
    if (this.closed) return this.failureValue;
    this.failIfExpired('persisted invocation lease expired before runner completion');
    this.finishing = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.renewal) await Promise.race([this.renewal, this.failureSignal]);
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    return this.failureValue;
  }

  private renew(): void {
    if (this.finishing || this.closed || this.failureValue || this.renewal) return;
    const leaseUntilMs = Date.now() + ACTIVE_INVOCATION_LEASE_MS;
    const renewal = this.renewLease(new Date(leaseUntilMs).toISOString())
      .then(() => {
        this.failIfExpired('persisted invocation lease renewal completed after expiry');
        if (!this.finishing && !this.closed && !this.failureValue) this.armExpiry(leaseUntilMs);
      })
      .catch((err) => this.fail(errorValue(err)))
      .finally(() => {
        if (this.renewal === renewal) this.renewal = undefined;
      });
    this.renewal = renewal;
  }

  private armExpiry(leaseUntilMs: number): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const failAt = leaseUntilMs - LEASE_FAIL_CLOSED_MARGIN_MS;
    this.leaseFailAtMs = failAt;
    this.expiryTimer = setTimeout(() => {
      this.fail(new Error('persisted invocation lease renewal did not complete before expiry'));
    }, Math.max(0, failAt - Date.now()));
    this.expiryTimer.unref?.();
  }

  private failIfExpired(message: string): void {
    if (this.leaseFailAtMs !== undefined && Date.now() >= this.leaseFailAtMs) this.fail(new Error(message));
  }

  private fail(error: Error): void {
    if (this.failureValue || this.closed) return;
    this.failureValue = error;
    this.failureResolve();
    this.onFailure(error);
  }
}

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
