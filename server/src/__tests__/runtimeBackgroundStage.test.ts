import { describe, expect, it } from 'vitest';

import { MemoryRunStore } from './runtimeScheduler.testHelpers.js';

describe('v2 background task stage', () => {
  it('keeps the staged run visible to recovery but unclaimable until ready', async () => {
    const runStore = new MemoryRunStore();
    await runStore.createPending({
      runId: 'run-background-staged',
      sessionId: 'session-background-staged',
      metadata: { backgroundTask: true, backgroundTaskVersion: 2, backgroundTaskReady: false },
    });

    await expect(runStore.listRecoverable()).resolves.toEqual([
      expect.objectContaining({ runId: 'run-background-staged' }),
    ]);
    await expect(
      runStore.acquireLease('run-background-staged', 'worker-background-staged', 60_000),
    ).resolves.toBeNull();

    await runStore.markStatus('run-background-staged', 'pending', undefined, {
      backgroundTaskReady: true,
    });
    await expect(runStore.listRecoverable()).resolves.toEqual([
      expect.objectContaining({ runId: 'run-background-staged' }),
    ]);
    await expect(
      runStore.acquireLease('run-background-staged', 'worker-background-ready', 60_000),
    ).resolves.toMatchObject({ runId: 'run-background-staged', status: 'running' });
  });
});
