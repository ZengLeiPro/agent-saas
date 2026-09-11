/** A read-only observation timeout is not proof that its remote request was cancelled. */
export class ConfigObservationTimeout extends Error {
  constructor() {
    super('ConfigIdentity observation exceeded its deadline');
    this.name = 'ConfigObservationTimeout';
  }
}

export async function observeWithinDeadline<T>(
  compute: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Only the winning observation can reach the caller's generation-fenced commit.
    // Promise.race also consumes a late rejection; it never publishes a late result.
    return await Promise.race([
      compute(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ConfigObservationTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
