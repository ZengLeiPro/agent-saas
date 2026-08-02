import { describe, expect, it, vi } from 'vitest';

import {
  MemoryPressureGuard,
  type MemoryPressureSample,
} from '../runtime/memoryPressureGuard.js';

const GIB = 1024 ** 3;

describe('MemoryPressureGuard', () => {
  it('pauses only after sustained real pressure and resumes after hysteresis', async () => {
    let now = 0;
    let sample: MemoryPressureSample = {
      totalBytes: 8 * GIB,
      availableBytes: 1 * GIB,
      psiSomeAvg10: 0,
      psiFullAvg10: 0,
      cgroupCurrentBytes: 2 * GIB,
      cgroupHighBytes: 3.6 * GIB,
    };
    const guard = new MemoryPressureGuard({
      sample: async () => sample,
      now: () => now,
      enterSustainMs: 3_000,
      resumeSustainMs: 30_000,
    });

    await guard.sampleOnce();
    expect(guard.canAcquire()).toBe(true);
    now = 2_999;
    await guard.sampleOnce();
    expect(guard.canAcquire()).toBe(true);
    now = 3_000;
    await guard.sampleOnce();
    expect(guard.getSnapshot()).toMatchObject({
      state: 'paused',
      admitting: false,
      reason: 'host_mem_available_low',
    });

    sample = {
      ...sample,
      availableBytes: 4 * GIB,
      cgroupCurrentBytes: 2 * GIB,
    };
    now = 4_000;
    await guard.sampleOnce();
    now = 33_999;
    await guard.sampleOnce();
    expect(guard.canAcquire()).toBe(false);
    now = 34_000;
    await guard.sampleOnce();
    expect(guard.getSnapshot()).toMatchObject({ state: 'healthy', admitting: true });
  });

  it('observes cgroup and PSI pressure and fails open when Linux metrics disappear', async () => {
    let now = 0;
    let current: MemoryPressureSample | null = {
      totalBytes: 8 * GIB,
      availableBytes: 5 * GIB,
      cgroupCurrentBytes: 3.3 * GIB,
      cgroupHighBytes: 3.6 * GIB,
      psiSomeAvg10: 0,
      psiFullAvg10: 0,
    };
    const warn = vi.fn();
    const guard = new MemoryPressureGuard({
      sample: async () => current,
      now: () => now,
      enterSustainMs: 0,
      logger: { info: vi.fn(), warn },
    });

    await guard.sampleOnce();
    expect(guard.getSnapshot().reason).toBe('worker_cgroup_near_high');
    current = null;
    now = 1_000;
    await guard.sampleOnce();
    expect(guard.getSnapshot()).toMatchObject({ state: 'unknown', admitting: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fail-open'));
  });
});
