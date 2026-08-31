import { describe, expect, it, vi } from 'vitest';
import { InvocationLeaseMonitor } from './invocationLeaseMonitor.js';

describe('InvocationLeaseMonitor fail-closed deadlines', () => {
  it('fails synchronously when the persisted lease is already inside the expiry margin', async () => {
    const renew = vi.fn(async () => undefined);
    const onFailure = vi.fn();
    const monitor = new InvocationLeaseMonitor(renew, onFailure);

    monitor.start(Date.now());

    expect(monitor.failure?.message).toContain('expired before runner start');
    expect(onFailure).toHaveBeenCalledOnce();
    expect(renew).not.toHaveBeenCalled();
    await expect(monitor.finish()).resolves.toBe(monitor.failure);
  });

  it('rechecks the persisted deadline before finish can cancel a delayed expiry timer', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-01T00:00:00.000Z');
    vi.setSystemTime(now);
    const onFailure = vi.fn();
    const monitor = new InvocationLeaseMonitor(async () => undefined, onFailure);
    monitor.start(now.getTime() + 6_000);

    vi.setSystemTime(now.getTime() + 2_000);
    const failure = await monitor.finish();

    expect(failure?.message).toContain('expired before runner completion');
    expect(onFailure).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
