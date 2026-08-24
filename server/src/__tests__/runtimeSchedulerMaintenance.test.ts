import { describe, expect, it, vi } from 'vitest';

import { RuntimeScheduler } from '../runtime/scheduler.js';
import { MemoryEventStore, MemoryRunStore } from './runtimeScheduler.testHelpers.js';

describe('RuntimeScheduler unified maintenance', () => {
  it('keeps pending runs queued during maintenance and resumes them after the shared switch opens', async () => {
    const runStore = new MemoryRunStore();
    await runStore.createPending({ runId: 'run-maintenance', sessionId: 'session-maintenance' });
    let executionEnabled = false;
    const wake = vi.fn(async (_record, lease) => {
      await lease.release('completed', 'done');
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore: new MemoryEventStore(),
      autoWake: true,
      pollIntervalMs: 60_000,
      executionEnabled,
      resolveExecutionEnabled: async () => executionEnabled,
      wake,
    });

    await scheduler.start();
    expect(wake).not.toHaveBeenCalled();
    await expect(runStore.get('run-maintenance')).resolves.toMatchObject({ status: 'pending' });

    executionEnabled = true;
    await scheduler.tick();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    await expect(runStore.get('run-maintenance')).resolves.toMatchObject({ status: 'completed' });
    await scheduler.stop();
  });
});
