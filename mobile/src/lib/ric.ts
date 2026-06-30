/**
 * Defer work until the JS thread is idle, avoiding competition
 * with animations and touch handling.
 *
 * Uses requestIdleCallback where available, with a
 * requestAnimationFrame + setTimeout(0) fallback that waits
 * at least one frame before executing.
 */

const hasRIC = typeof requestIdleCallback === 'function';

function ricFallback(cb: () => void): number {
  // Wait for next frame, then yield to let pending work finish
  return requestAnimationFrame(() => setTimeout(cb, 0)) as unknown as number;
}

function cancelFallback(id: number): void {
  cancelAnimationFrame(id);
}

export function scheduleIdle(cb: () => void): () => void {
  if (hasRIC) {
    const id = requestIdleCallback(cb);
    return () => cancelIdleCallback(id);
  }
  const id = ricFallback(cb);
  return () => cancelFallback(id);
}
