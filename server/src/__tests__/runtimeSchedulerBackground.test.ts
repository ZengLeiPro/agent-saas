import { describe, expect, it, vi } from 'vitest';

import { RuntimeScheduler } from '../runtime/scheduler.js';
import type { RunRecord, RunStatus } from '../runtime/runStore.js';
import { deferred, MemoryEventStore, MemoryRunStore } from './runtimeScheduler.testHelpers.js';

describe('RuntimeScheduler background task recovery', () => {
  it('freezes an expired running background task and never calls wake to replay it', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const record = await runStore.upsertPending({
      runId: 'bg-crashed',
      sessionId: 'sub-bg-crashed',
      metadata: { backgroundTask: true, wakeState: 'none' },
    });
    runStore.records.set(record.runId, {
      ...record,
      status: 'running',
      workerId: 'dead-worker',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const wake = vi.fn();
    const failInterrupted = vi.fn(async (candidate: RunRecord) => {
      await runStore.markStatus(candidate.runId, 'failed', 'background_task_interrupted_no_replay', {
        wakeState: 'pending',
      });
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-new',
      autoWake: true,
      wake,
      failInterruptedBackgroundTask: failInterrupted,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failInterrupted).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
    await expect(runStore.get('bg-crashed')).resolves.toMatchObject({
      status: 'failed',
      statusReason: 'background_task_interrupted_no_replay',
      metadata: { wakeState: 'pending' },
    });
  });

  it('re-acquires an expired background command monitor without replaying the command', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const record = await runStore.upsertPending({
      runId: 'shell-bg-recover',
      sessionId: 'sub-shell-recover',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'command',
        backgroundTaskReady: true,
      },
    });
    runStore.records.set(record.runId, {
      ...record,
      status: 'running',
      workerId: 'dead-monitor',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const failInterrupted = vi.fn();
    const wake = vi.fn(async (_candidate: RunRecord, lease: { release(status?: RunStatus): Promise<void> }) => {
      await lease.release('completed');
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-new',
      autoWake: true,
      wake,
      failInterruptedBackgroundTask: failInterrupted,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failInterrupted).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ runId: 'shell-bg-recover' }), expect.anything());
    await expect(runStore.get('shell-bg-recover')).resolves.toMatchObject({ status: 'completed' });
  });

  it('does not lease a reserved background command until ACS start is acknowledged', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({
      runId: 'shell-bg-starting',
      sessionId: 'sub-shell-starting',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'command',
        backgroundTaskVersion: 2,
        backgroundTaskReady: false,
      },
    });
    const wake = vi.fn();
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(wake).not.toHaveBeenCalled();
    await expect(runStore.get('shell-bg-starting')).resolves.toMatchObject({ status: 'pending' });
  });

  it('fails and cleans up a background command reservation whose ACS acknowledgement never arrived', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const record = await runStore.upsertPending({
      runId: 'shell-bg-stale-start',
      sessionId: 'sub-shell-stale-start',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'command',
        backgroundTaskVersion: 2,
        backgroundTaskReady: false,
      },
    });
    runStore.records.set(record.runId, {
      ...record,
      requestedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    });
    const failBackgroundTask = vi.fn(async (candidate: RunRecord, message: string) => {
      await runStore.markStatus(candidate.runId, 'failed', 'background_command_start_timeout', {
        wakeState: 'pending',
        error: message,
      });
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: vi.fn(),
      failBackgroundTask,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failBackgroundTask).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'shell-bg-stale-start' }),
      expect.stringContaining('启动确认超时'),
    );
    await expect(runStore.get('shell-bg-stale-start')).resolves.toMatchObject({
      status: 'failed',
      metadata: { wakeState: 'pending' },
    });
  });

  it('fails a stale staged background Agent that crashed before activation', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const record = await runStore.upsertPending({
      runId: 'agent-bg-stale-start',
      sessionId: 'sub-agent-stale-start',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'agent',
        backgroundTaskVersion: 2,
        backgroundTaskReady: false,
      },
    });
    runStore.records.set(record.runId, {
      ...record,
      requestedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    });
    const failBackgroundTask = vi.fn(async (candidate: RunRecord, message: string) => {
      await runStore.markStatus(candidate.runId, 'failed', 'background_agent_start_timeout', {
        wakeState: 'pending',
        error: message,
      });
    });
    const wake = vi.fn();
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake,
      failBackgroundTask,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failBackgroundTask).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'agent-bg-stale-start' }),
      expect.stringContaining('Agent 启动确认超时'),
    );
    expect(wake).not.toHaveBeenCalled();
    await expect(runStore.get('agent-bg-stale-start')).resolves.toMatchObject({
      status: 'failed',
      metadata: { wakeState: 'pending' },
    });
  });

  it('hands off an in-flight background command monitor during scheduler drain', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({
      runId: 'shell-bg-drain',
      sessionId: 'sub-shell-drain',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'command',
        backgroundTaskReady: true,
      },
    });
    const wakeEntered = deferred();
    const handedOff = deferred();
    const handoffBackgroundCommand = vi.fn(() => handedOff.resolve());
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async (_record, lease) => {
        wakeEntered.resolve();
        await handedOff.promise;
        await lease.handoff('background_command_monitor_handoff');
      },
      handoffBackgroundCommand,
    });

    await scheduler.tick();
    await wakeEntered.promise;
    await scheduler.stop();

    expect(handoffBackgroundCommand).toHaveBeenCalledWith(expect.objectContaining({ runId: 'shell-bg-drain' }));
    await expect(runStore.get('shell-bg-drain')).resolves.toMatchObject({
      status: 'running',
      workerId: undefined,
      leaseExpiresAt: undefined,
      liveness: { state: 'unknown' },
    });
  });

  it('freezes a pending background task when a pre-wake tenant/billing gate rejects it', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({
      runId: 'bg-blocked',
      sessionId: 'sub-bg-blocked',
      metadata: { backgroundTask: true, wakeState: 'none' },
    });
    const failBackground = vi.fn(async (candidate: RunRecord, message: string) => {
      await runStore.markStatus(candidate.runId, 'failed', 'background_task_start_failed', {
        wakeState: 'pending',
        backgroundResult: { status: 'failed', text: '', errorMessage: message },
      });
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async () => { throw new Error('组织积分余额不足'); },
      failBackgroundTask: failBackground,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failBackground).toHaveBeenCalledWith(expect.objectContaining({ runId: 'bg-blocked' }), '组织积分余额不足');
    await expect(runStore.get('bg-blocked')).resolves.toMatchObject({
      status: 'failed',
      metadata: { wakeState: 'pending' },
    });
  });

});
