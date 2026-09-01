import { describe, expect, it, vi } from 'vitest';

import { cleanupManagedSandboxes, type SandboxCleanupHost } from './sandboxCleanup.js';
import type { ManagedSandbox } from './sandboxState.js';

function candidate(name: string): ManagedSandbox {
  return {
    name,
    phase: 'Paused',
    createdAt: '2026-08-30T00:00:00.000Z',
    lastActiveAt: '2026-08-30T00:00:00.000Z',
  };
}

describe('sandbox cleanup candidate isolation', () => {
  it('continues reclaiming later candidates when the first candidate throws', async () => {
    const first = candidate('as-first');
    const second = candidate('as-second');
    const warn = vi.fn();
    const deleteWhenIdle = vi.fn(async (name: string): Promise<string[] | null> => {
      if (name === first.name) throw new Error('delete failed');
      return [];
    });
    const host: SandboxCleanupHost = {
      lifecyclePolicyMode: 'shadow',
      sandboxBrokenRecycleGraceMs: 0,
      sandboxOrphanGraceMs: 60_000,
      sandboxTtlMs: 60_000,
      sandboxIdlePauseMs: 0,
      listManagedSandboxes: async () => [first, second],
      isBusy: () => false,
      deleteWhenIdle,
      pauseWhenIdle: async () => false,
      cleanupOrphanSnat: async () => ({
        enabled: false, checked: 0, deleted: [], orphanCidrs: [], unexpected: [],
      }),
      warn,
    };

    const report = await cleanupManagedSandboxes(host, {
      now: new Date('2026-08-30T00:10:00.000Z'),
    });

    expect(deleteWhenIdle).toHaveBeenCalledTimes(2);
    expect(report.deleted).toEqual([second.name]);
    expect(report.decisionCounts?.['candidate-error']).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`name=${first.name}`));
  });
});
