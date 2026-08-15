import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeDrainHandoffState } from '../agent/types.js';
import { runtimeRunController } from '../runtime/runController.js';

const runIds: string[] = [];
afterEach(() => {
  for (const runId of runIds.splice(0)) runtimeRunController.unregister(runId);
  vi.useRealTimers();
});

describe('runtimeRunController', () => {
  it('requests cooperative drain handoff without aborting foreground runs', () => {
    const controller = new AbortController();
    const durable = new AbortController();
    const drainHandoff: RuntimeDrainHandoffState = { requested: false };
    runtimeRunController.register('handoff-run', controller, { drainHandoff });
    runtimeRunController.register('handoff-background-run', durable, {
      abortOnDrain: false,
      drainHandoff: { requested: false },
    });

    try {
      expect(runtimeRunController.requestAllForDrain('server_drain_handoff')).toBe(1);
      expect(drainHandoff).toMatchObject({
        requested: true,
        reason: 'server_drain_handoff',
      });
      expect(drainHandoff.requestedAt).toEqual(expect.any(String));
      expect(controller.signal.aborted).toBe(false);
      expect(durable.signal.aborted).toBe(false);
      expect(runtimeRunController.requestAllForDrain('duplicate')).toBe(0);
    } finally {
      runtimeRunController.unregister('handoff-run');
      runtimeRunController.unregister('handoff-background-run');
    }
  });

  it('aborts every drain-interruptible run once, preserves reason, and leaves durable background work alone', () => {
    const first = new AbortController();
    const second = new AbortController();
    const durable = new AbortController();
    runtimeRunController.register('drain-run-1', first);
    runtimeRunController.register('drain-run-2', second);
    runtimeRunController.register('durable-background-run', durable, { abortOnDrain: false });

    try {
      expect(runtimeRunController.abortAllForDrain('server_drain_deadline')).toBe(2);
      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(true);
      expect(durable.signal.aborted).toBe(false);
      expect(first.signal.reason).toMatchObject({ message: 'server_drain_deadline' });
      expect(second.signal.reason).toMatchObject({ message: 'server_drain_deadline' });
      expect(runtimeRunController.abortAllForDrain('duplicate')).toBe(0);
    } finally {
      runtimeRunController.unregister('drain-run-1');
      runtimeRunController.unregister('drain-run-2');
      runtimeRunController.unregister('durable-background-run');
    }
  });

  it('最大墙钟到期终止仍在运行的普通 Run', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    runtimeRunController.armWallClock('wall-clock-running', controller, {
      maxWallClockMs: 1_000,
      shouldAbort: async () => true,
    });
    runIds.push('wall-clock-running');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ message: 'run_max_wall_clock_exceeded' });
    vi.useRealTimers();
  });

  it('最大墙钟不终止 waiting_approval 等人工等待态', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    runtimeRunController.armWallClock('wall-clock-approval', controller, {
      maxWallClockMs: 1_000,
      shouldAbort: async () => false,
    });
    runIds.push('wall-clock-approval');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(controller.signal.aborted).toBe(false);
    vi.useRealTimers();
  });

  it('shouldAbort reject 被吸收且不会误终止运行', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    runtimeRunController.armWallClock('wall-clock-reject', controller, {
      maxWallClockMs: 1_000,
      shouldAbort: async () => { throw new Error('run store unavailable'); },
    });
    runIds.push('wall-clock-reject');

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(controller.signal.aborted).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('完成/重新 arm 会使已触发但尚未完成的旧墙钟回调失效', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let resolveShouldAbort!: (value: boolean) => void;
    const pendingDecision = new Promise<boolean>((resolve) => { resolveShouldAbort = resolve; });
    runtimeRunController.armWallClock('wall-clock-race', controller, {
      maxWallClockMs: 1_000,
      shouldAbort: () => pendingDecision,
    });
    runIds.push('wall-clock-race');

    await vi.advanceTimersByTimeAsync(1_000);
    runtimeRunController.armWallClock('wall-clock-race', controller, {
      maxWallClockMs: 2_000,
      shouldAbort: async () => false,
    });
    resolveShouldAbort(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.signal.aborted).toBe(false);
  });

  it('aborts every registered background or raw run owned by one immutable user only', () => {
    const aliceAgent = new AbortController();
    const aliceCommand = new AbortController();
    const bobAgent = new AbortController();
    runtimeRunController.register('alice-agent', aliceAgent, { userId: 'user-alice' });
    runtimeRunController.register('alice-command', aliceCommand, { userId: 'user-alice' });
    runtimeRunController.register('bob-agent', bobAgent, { userId: 'user-bob' });
    runIds.push('alice-agent', 'alice-command', 'bob-agent');

    expect(runtimeRunController.abortByUser('user-alice', 'user access revoked')).toBe(2);
    expect(aliceAgent.signal.aborted).toBe(true);
    expect(aliceCommand.signal.aborted).toBe(true);
    expect(bobAgent.signal.aborted).toBe(false);
  });

  it('aborts active runs in the suspended tenant across foreground and background registrations', () => {
    const first = new AbortController();
    const second = new AbortController();
    const other = new AbortController();
    runtimeRunController.register('tenant-a-foreground', first, { tenantId: 'tenant-a' });
    runtimeRunController.register('tenant-a-background', second, { tenantId: 'tenant-a', abortOnDrain: false });
    runtimeRunController.register('tenant-b-foreground', other, { tenantId: 'tenant-b' });
    runIds.push('tenant-a-foreground', 'tenant-a-background', 'tenant-b-foreground');

    expect(runtimeRunController.abortByTenant('tenant-a', 'Tenant disabled')).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });
});
