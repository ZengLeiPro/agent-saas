import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPressureGuard, type MemoryPressureSample } from '../runtime/memoryPressureGuard.js';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const totalBytes = 3674912 * 1024;
const observedAvailable = 1113736 * 1024;

function harness(environment = 'staging', initialAvailable = observedAvailable) {
  let now = 0;
  let current: MemoryPressureSample = {
    totalBytes,
    availableBytes: initialAvailable,
    psiSomeAvg10: 0,
    psiFullAvg10: 0,
    cgroupCurrentBytes: 533 * MIB,
  };
  const guard = new MemoryPressureGuard({
    environment,
    sample: async () => current,
    now: () => now,
  });
  return {
    guard,
    async at(time: number, update: Partial<MemoryPressureSample> = {}) {
      now = time;
      current = { ...current, ...update };
      return guard.sampleOnce();
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('Staging size-aware memory admission', () => {
  it('accepts the RC114 host snapshot without clearing caches or adding swap', async () => {
    const { guard, at } = harness();
    for (const time of [0, 3000, 10_000, 60_000]) {
      expect(await at(time)).toMatchObject({
        state: 'healthy',
        admitting: true,
        enterAvailableBytes: totalBytes * 0.15,
        resumeAvailableBytes: totalBytes * 0.25,
      });
    }
    expect(guard.canAcquire()).toBe(true);
  });

  it.each([1185, 1171, 1065])('accepts observed headroom of %i MiB', async (available) => {
    const { at } = harness('staging', available * MIB);
    expect(await at(0)).toMatchObject({ state: 'healthy', admitting: true });
    expect(await at(30_000)).toMatchObject({ state: 'healthy', admitting: true });
  });

  it('ignores a brief dip on an already healthy worker', async () => {
    const { guard, at } = harness();
    await at(0);
    await at(1000, { availableBytes: 500 * MIB });
    expect((await at(3999)).admitting).toBe(true);
    await at(4000, { availableBytes: observedAvailable });
    await at(5000, { availableBytes: 500 * MIB });
    expect((await at(7999)).admitting).toBe(true);
    expect(guard.canAcquire()).toBe(true);
    expect(await at(8000)).toMatchObject({
      state: 'paused',
      admitting: false,
      reason: 'host_mem_available_low',
    });
  });

  it('recovers at actual Staging headroom after 10 seconds, not 2.5 GiB', async () => {
    const { guard, at } = harness('staging', 500 * MIB);
    expect((await at(0)).admitting).toBe(false);
    await at(1000, { availableBytes: observedAvailable });
    expect((await at(10_999)).admitting).toBe(false);
    expect(await at(11_000)).toMatchObject({ state: 'healthy', admitting: true });
    expect(guard.canAcquire()).toBe(true);
    expect(guard.getSnapshot().reason).toBeUndefined();
  });

  it('requires continuous recovery and does not flap in the hysteresis band', async () => {
    const { at } = harness('staging', 500 * MIB);
    await at(0);
    await at(1000, { availableBytes: observedAvailable });
    await at(9000, { availableBytes: 800 * MIB });
    expect((await at(20_000)).admitting).toBe(false);
    await at(21_000, { availableBytes: observedAvailable });
    expect((await at(30_999)).admitting).toBe(false);
    expect((await at(31_000)).admitting).toBe(true);
    expect((await at(32_000, { availableBytes: 800 * MIB })).admitting).toBe(true);
  });

  it('does not advertise startup readiness when the first valid sample is low', async () => {
    const { guard, at } = harness('staging', 500 * MIB);
    expect(await at(0)).toMatchObject({ state: 'paused', admitting: false });
    expect(guard.canAcquire()).toBe(false);
  });

  it('immediately pauses critical host headroom without the normal debounce', async () => {
    const { guard, at } = harness();
    await at(0);
    expect(await at(1, { availableBytes: 255 * MIB })).toMatchObject({
      state: 'paused',
      admitting: false,
      reason: 'host_mem_available_critical',
    });
    expect(guard.canAcquire()).toBe(false);
  });

  it.each([
    [2, 512, 768],
    [4, 614.4, 1024],
    [8, 1228.8, 2048],
  ])('scales reserves on a %i GiB Staging host', async (total, pause, resume) => {
    const { at } = harness();
    const snapshot = await at(0, { totalBytes: total * GIB, availableBytes: total * GIB });
    expect(snapshot.enterAvailableBytes! / MIB).toBeCloseTo(pause);
    expect(snapshot.resumeAvailableBytes! / MIB).toBeCloseTo(resume);
    expect(snapshot.resumeAvailableBytes!).toBeGreaterThan(snapshot.enterAvailableBytes!);
  });

  it('uses strict threshold boundaries without adding caches to MemAvailable', async () => {
    const { at } = harness();
    const pause = totalBytes * 0.15;
    const resume = totalBytes * 0.25;
    expect((await at(0, { availableBytes: pause })).admitting).toBe(true);
    await at(1000, { availableBytes: pause - 1, cgroupSlabReclaimableBytes: 542 * MIB });
    expect((await at(4000)).admitting).toBe(false);
    await at(5000, { availableBytes: resume });
    expect((await at(20_000)).admitting).toBe(false);
    await at(21_000, { availableBytes: resume + 1 });
    expect((await at(31_000)).admitting).toBe(true);
  });

  it.each([
    [{ psiFullAvg10: 2 }, 'memory_psi_full'],
    [{ psiSomeAvg10: 10 }, 'memory_psi_some'],
    [{ cgroupCurrentBytes: 930 * MIB, cgroupHighBytes: GIB }, 'worker_cgroup_near_high'],
  ] as const)('retains independent pressure protection: %j', async (pressure, reason) => {
    const { at } = harness();
    await at(0);
    expect((await at(1000, pressure)).admitting).toBe(true);
    expect(await at(4000)).toMatchObject({ state: 'paused', admitting: false, reason });
  });

  it.each([
    { psiFullAvg10: 1 },
    { psiSomeAvg10: 5 },
    { cgroupCurrentBytes: 750 * MIB, cgroupHighBytes: GIB },
  ])('does not recover while other pressure remains: %j', async (pressure) => {
    const { at } = harness('staging', 500 * MIB);
    await at(0);
    await at(1000, { availableBytes: observedAvailable, ...pressure });
    expect((await at(60_000)).admitting).toBe(false);
  });

  it('automatically selects the existing staging environment with no new setting', async () => {
    vi.stubEnv('AGENT_SAAS_ENVIRONMENT', 'staging');
    const guard = new MemoryPressureGuard({
      sample: async () => ({ totalBytes, availableBytes: observedAvailable }),
    });
    expect(await guard.sampleOnce()).toMatchObject({
      state: 'healthy',
      enterAvailableBytes: totalBytes * 0.15,
      resumeAvailableBytes: totalBytes * 0.25,
    });
  });

  it.each(['production', 'test', 'development', 'stagin', ''])(
    'does not lower reserves outside explicit staging: %s',
    async (environment) => {
      const { at } = harness(environment);
      expect(await at(0)).toMatchObject({
        state: 'unknown',
        admitting: true,
        enterAvailableBytes: 1.5 * GIB,
        resumeAvailableBytes: 2.5 * GIB,
      });
      expect((await at(3000)).admitting).toBe(false);
      await at(4000, { availableBytes: 3 * GIB });
      expect((await at(14_000)).admitting).toBe(false);
      expect((await at(34_000)).admitting).toBe(true);
    },
  );

  it('logs the selected policy and actual thresholds during normal startup', async () => {
    const info = vi.fn();
    const guard = new MemoryPressureGuard({
      environment: 'staging',
      sample: async () => ({ totalBytes, availableBytes: observedAvailable }),
      logger: { info, warn: vi.fn() },
    });
    try {
      await guard.start();
      expect(info).toHaveBeenCalledWith(expect.stringContaining('policy=staging-size-aware'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('pauseBelow=538MiB'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('resumeAbove=897MiB'));
    } finally {
      guard.stop();
    }
  });

  it('defaults to the standard policy when the runtime environment is absent', async () => {
    vi.stubEnv('AGENT_SAAS_ENVIRONMENT', undefined);
    const guard = new MemoryPressureGuard({
      sample: async () => ({ totalBytes, availableBytes: observedAvailable }),
    });
    expect((await guard.sampleOnce()).enterAvailableBytes).toBe(1.5 * GIB);
  });
});
