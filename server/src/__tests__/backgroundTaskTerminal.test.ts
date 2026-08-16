import { describe, expect, it, vi } from 'vitest';

import { markBackgroundTaskTerminal } from '../runtime/background/backgroundTaskTerminal.js';
import type { RunStore } from '../runtime/runStore.js';

describe('background task terminal CAS', () => {
  it('only transitions pending/running and never overwrites a concurrent cancellation', async () => {
    const markStatusIfCurrent = vi.fn().mockResolvedValue(null);
    const markStatus = vi.fn();
    const store = {
      markStatusIfCurrent,
      markStatus,
      get: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    } as unknown as RunStore;

    await expect(markBackgroundTaskTerminal(
      store, 'bg-1', 'completed', undefined, { backgroundResult: { status: 'completed' } },
    )).resolves.toBeNull();
    expect(markStatusIfCurrent).toHaveBeenCalledWith(
      'bg-1', ['pending', 'running'], 'completed', undefined,
      { backgroundResult: { status: 'completed' } },
    );
    expect(markStatus).not.toHaveBeenCalled();
  });
});
