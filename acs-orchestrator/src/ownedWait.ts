/** A waiter deadline never cancels, deletes or otherwise releases the work it observes. */
export class OwnedWaitEndedError extends Error {
  readonly code: 'wait_cancelled' | 'wait_timed_out';
  constructor(code: 'wait_cancelled' | 'wait_timed_out', readonly phase: string) {
    super(`${phase}: ${code}`);
    this.name = 'OwnedWaitEndedError';
    this.code = code;
  }
}

export interface OwnedWaitOptions {
  phase: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function waitForOwned<T>(work: PromiseLike<T>, options: OwnedWaitOptions): Promise<T> {
  // Always observe the owner, including after a caller detaches, to avoid unhandled
  // late rejections. The owner remains responsible for all late side effects.
  const observed = Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(new OwnedWaitEndedError('wait_cancelled', options.phase));
    observed.then((value) => finish(undefined, value), (error: unknown) => finish(error));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    if (options.timeoutMs !== undefined) {
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
        finish(new RangeError('Owned wait timeout must be finite and non-negative'));
        return;
      }
      timer = setTimeout(() => finish(new OwnedWaitEndedError('wait_timed_out', options.phase)), options.timeoutMs);
      timer.unref?.();
    }
  });
}

export const OWNED_WAIT_BUDGETS = Object.freeze({
  ensureMs: 10 * 60_000,
  readyMs: 3_000,
  heartbeatStaleMs: 40_000,
  heartbeatTickMs: 10_000,
  cancellationMs: 4_000,
  persistenceMs: 10_000,
  termGraceMs: 2_000,
  killGraceMs: 2_000,
  maxForegroundMs: 30 * 60_000,
  maxLegacyListenerMs: 24 * 60 * 60_000,
});
