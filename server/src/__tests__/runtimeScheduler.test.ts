import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeScheduler,
  SCHEDULER_STATE_METADATA_KEY,
  SCHEDULER_STATE_READY,
  SCHEDULER_STATE_STAGED,
} from '../runtime/scheduler.js';
import type { RunRecord, RunStatus, UpsertRunInput } from '../runtime/runStore.js';
import { deferred, MemoryEventStore, MemoryRunStore } from './runtimeScheduler.testHelpers.js';

async function flushSchedulerMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('RuntimeScheduler', () => {
  it('keeps staged pending runs out of recovery and lease acquisition', async () => {
    const runStore = new MemoryRunStore();
    await runStore.createPending({
      runId: 'run-staged',
      sessionId: 'session-staged',
      metadata: { [SCHEDULER_STATE_METADATA_KEY]: SCHEDULER_STATE_STAGED },
    });

    await expect(runStore.listRecoverable()).resolves.toEqual([]);
    await expect(runStore.acquireLease('run-staged', 'worker-staged', 60_000)).resolves.toBeNull();
  });

  it('does not wake while session setup is blocked, then schedules after activation', async () => {
    const runStore = new MemoryRunStore();
    const wake = vi.fn(async (_record, lease) => {
      await lease.release('completed', 'done');
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore: new MemoryEventStore(),
      workerId: 'worker-staged-activation',
      pollIntervalMs: 60_000,
      autoWake: true,
      wake,
    });
    await scheduler.start();
    const setupGate = deferred();
    await scheduler.enqueueCreateOnly({
      runId: 'run-staged-activation',
      sessionId: 'session-staged-activation',
      metadata: { [SCHEDULER_STATE_METADATA_KEY]: SCHEDULER_STATE_STAGED },
    });

    await flushSchedulerMicrotasks();
    await scheduler.tick();
    expect(wake).not.toHaveBeenCalled();

    setupGate.resolve();
    await setupGate.promise;
    await expect(scheduler.activateCreatedRun('run-staged-activation')).resolves.toMatchObject({
      status: 'pending',
      metadata: { [SCHEDULER_STATE_METADATA_KEY]: SCHEDULER_STATE_READY },
    });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    await scheduler.stop();
  });

  it('stages only legacy pending Taskboard runs and observes a concurrent running winner', async () => {
    const runStore = new MemoryRunStore();
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore: new MemoryEventStore(),
    });
    await runStore.createPending({
      runId: 'run-legacy-stage',
      sessionId: 'session-legacy-stage',
      metadata: { taskboardExecution: true },
    });
    await expect(scheduler.stagePendingRun('run-legacy-stage')).resolves.toMatchObject({
      status: 'pending',
      metadata: { taskboardExecution: true, schedulerState: SCHEDULER_STATE_STAGED },
    });

    await runStore.createPending({
      runId: 'run-legacy-stage-race',
      sessionId: 'session-legacy-stage-race',
      metadata: { taskboardExecution: true },
    });
    await runStore.markStatus('run-legacy-stage-race', 'running');
    await expect(scheduler.stagePendingRun('run-legacy-stage-race')).resolves.toMatchObject({
      status: 'running',
      metadata: { taskboardExecution: true },
    });
    await expect(runStore.get('run-legacy-stage-race')).resolves.toMatchObject({ status: 'running' });
  });

  it('concurrent activation never demotes a run that already acquired its lease', async () => {
    const runStore = new MemoryRunStore();
    await runStore.createPending({
      runId: 'run-concurrent-activation',
      sessionId: 'session-concurrent-activation',
      metadata: { [SCHEDULER_STATE_METADATA_KEY]: SCHEDULER_STATE_STAGED },
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore: new MemoryEventStore(),
      workerId: 'worker-concurrent-activation',
    });

    const [, leased, observed] = await Promise.all([
      runStore.activateStagedRun('run-concurrent-activation'),
      runStore.acquireLease('run-concurrent-activation', 'other-worker', 60_000),
      scheduler.activateCreatedRun('run-concurrent-activation'),
    ]);

    expect(leased).toMatchObject({ status: 'running', workerId: 'other-worker' });
    expect(observed).toMatchObject({ status: 'running', workerId: 'other-worker' });
    await expect(runStore.get('run-concurrent-activation')).resolves.toMatchObject({
      status: 'running',
      workerId: 'other-worker',
    });
  });

  it.each(['running', 'completed', 'failed', 'cancelled', 'orphaned'] as const)(
    'activation is idempotent for an already %s run',
    async (status) => {
      const runStore = new MemoryRunStore();
      await runStore.createPending({
        runId: `run-activation-${status}`,
        sessionId: `session-activation-${status}`,
        metadata: { [SCHEDULER_STATE_METADATA_KEY]: SCHEDULER_STATE_STAGED },
      });
      await runStore.markStatus(`run-activation-${status}`, status);
      const scheduler = new RuntimeScheduler({
        runStore,
        eventStore: new MemoryEventStore(),
      });

      await expect(scheduler.activateCreatedRun(`run-activation-${status}`)).resolves.toMatchObject({ status });
      await expect(runStore.get(`run-activation-${status}`)).resolves.toMatchObject({ status });
    },
  );

  it('create-only enqueue returns an existing waiting run without resuming it', async () => {
    const runStore = new MemoryRunStore();
    const input: UpsertRunInput = {
      runId: 'run-create-only',
      sessionId: 'session-create-only',
      userId: 'user-1',
      channel: 'taskboard',
      model: 'test-model',
      metadata: { taskboardExecution: true },
    };
    await runStore.upsertPending(input);
    await runStore.markStatus(input.runId, 'waiting_user');
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore: new MemoryEventStore(),
      workerId: 'worker-1',
      autoWake: true,
      wake: vi.fn(),
    });

    await expect(scheduler.enqueueCreateOnly(input)).resolves.toMatchObject({ status: 'waiting_user' });
    await expect(runStore.get(input.runId)).resolves.toMatchObject({ status: 'waiting_user' });
  });

  it('reports an in-flight workload snapshot without session or user identifiers', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const wakeGate = deferred();
    await runStore.upsertPending({
      runId: 'run-performance-1',
      sessionId: 'session-sensitive-1',
      userId: 'user-sensitive-1',
      channel: 'web',
      model: 'test-model',
      executionTarget: 'server-container',
      metadata: { backgroundTask: true },
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      maxConcurrentRuns: 16,
      autoWake: true,
      wake: async (_record, lease) => {
        await wakeGate.promise;
        await lease.release('completed', 'done');
      },
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();
    const snapshot = scheduler.getPerformanceSnapshot(Date.now() + 1_000);

    expect(snapshot).toMatchObject({
      maxConcurrentRuns: 16,
      inFlightRuns: 1,
      inFlightBackgroundRuns: 1,
      byRunClass: { background_agent: 1 },
      byChannel: { web: 1 },
      byExecutionTarget: { 'server-container': 1 },
      byModel: { 'test-model': 1 },
    });
    expect(JSON.stringify(snapshot)).not.toContain('session-sensitive-1');
    expect(JSON.stringify(snapshot)).not.toContain('user-sensitive-1');

    wakeGate.resolve();
    await flushSchedulerMicrotasks();
    await scheduler.stop();
  });

  it('cancels waiting approvals older than the configured timeout', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const staleUpdatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    runStore.records.set('run-stale', {
      runId: 'run-stale',
      sessionId: 'session-stale',
      tenantId: 'wain-test',
      userId: 'user-1',
      status: 'waiting_approval',
      statusReason: 'approval:approval-1',
      requestedAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      metadata: {},
    });
    await eventStore.append({
      type: 'approval_requested',
      runId: 'run-stale',
      sessionId: 'session-stale',
      approvalId: 'approval-1',
      toolCallId: 'call-1',
      toolId: 'Shell',
      toolName: 'Shell',
      input: { cmd: 'date' },
    }, { tenantId: 'wain-test' });

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      approvalTimeoutMs: 24 * 60 * 60 * 1000,
      wake: async () => {
        throw new Error('stale approval should not be leased');
      },
    });

    await scheduler.tick();
    await scheduler.stop();

    await expect(runStore.get('run-stale')).resolves.toMatchObject({
      status: 'cancelled',
      statusReason: 'stale_waiting_approval_timeout',
    });
    expect(eventStore.events.map((event) => event.type)).toEqual([
      'approval_requested',
      'approval_resolved',
      'run_cancel_requested',
      'run_state_changed',
    ]);
    expect(eventStore.events[1]).toMatchObject({
      type: 'approval_resolved',
      approvalId: 'approval-1',
      decision: 'rejected',
      message: 'stale_waiting_approval_timeout',
    });
    expect(eventStore.events[3]).toMatchObject({
      type: 'run_state_changed',
      runId: 'run-stale',
      status: 'cancelled',
      previousStatus: 'waiting_approval',
      reason: 'stale_waiting_approval_timeout',
    });
    expect(eventStore.appendContexts.map((ctx) => ctx?.tenantId)).toEqual(['wain-test', 'wain-test', 'wain-test', 'wain-test']);
  });

  it('keeps fresh waiting approvals pending', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const freshUpdatedAt = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    runStore.records.set('run-fresh', {
      runId: 'run-fresh',
      sessionId: 'session-fresh',
      status: 'waiting_approval',
      statusReason: 'approval:approval-1',
      requestedAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
      metadata: {},
    });

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      approvalTimeoutMs: 24 * 60 * 60 * 1000,
    });

    await scheduler.tick();
    await scheduler.stop();

    await expect(runStore.get('run-fresh')).resolves.toMatchObject({
      status: 'waiting_approval',
      statusReason: 'approval:approval-1',
    });
    expect(eventStore.events).toEqual([]);
  });

  it('leases recoverable runs and marks them orphaned when autoWake is disabled', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-1', sessionId: 'session-1', tenantId: 'wain-test' });

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: false,
    });

    await scheduler.tick();
    await scheduler.stop();

    await expect(runStore.get('run-1')).resolves.toMatchObject({
      status: 'orphaned',
      statusReason: 'scheduler_recovery_scan',
    });
    expect(eventStore.events.map((event) => event.type)).toEqual(['run_lease_acquired', 'run_state_changed']);
    expect(eventStore.appendContexts.map((ctx) => ctx?.tenantId)).toEqual(['wain-test', 'wain-test']);
  });

  it('hands acquired leases to wake when autoWake is enabled', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-1', sessionId: 'session-1' });
    let renewed = false;

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async (_record, lease) => {
        await lease.renew();
        renewed = true;
        await lease.release('completed', 'done');
      },
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(renewed).toBe(true);
    await expect(runStore.get('run-1')).resolves.toMatchObject({ status: 'completed', statusReason: 'done' });
  });

  it('coalesces concurrent renew calls for the same scheduler lease', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const renewGate = deferred();
    await runStore.upsertPending({ runId: 'run-renew-single-flight', sessionId: 'session-renew-single-flight' });
    const originalRenew = runStore.renewLease.bind(runStore);
    let renewCalls = 0;
    runStore.renewLease = async (...args) => {
      renewCalls += 1;
      await renewGate.promise;
      return originalRenew(...args);
    };

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async (_record, lease) => {
        const first = lease.renew();
        const second = lease.renew();
        await Promise.resolve();
        expect(renewCalls).toBe(1);
        renewGate.resolve();
        await Promise.all([first, second]);
        await lease.release('completed', 'done');
      },
    });

    await scheduler.tick();
    await scheduler.stop();
    expect(renewCalls).toBe(1);
  });

  it('ticks immediately after enqueue when the scheduler is started', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const started: string[] = [];

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      autoWake: true,
      wake: async (record, lease) => {
        started.push(record.runId);
        await lease.release('completed', 'done');
      },
    });

    await scheduler.start();
    await scheduler.enqueue({ runId: 'run-enqueue-1', sessionId: 'session-enqueue-1' });
    await flushSchedulerMicrotasks();
    await scheduler.stop();

    expect(started).toEqual(['run-enqueue-1']);
    await expect(runStore.get('run-enqueue-1')).resolves.toMatchObject({ status: 'completed', statusReason: 'done' });
  });

  it('does not tick after enqueue when the scheduler worker is not started', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    let wakeCalled = false;

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      autoWake: true,
      wake: async () => {
        wakeCalled = true;
      },
    });

    await scheduler.enqueue({ runId: 'run-enqueue-disabled', sessionId: 'session-enqueue-disabled' });
    await flushSchedulerMicrotasks();

    expect(wakeCalled).toBe(false);
    await expect(runStore.get('run-enqueue-disabled')).resolves.toMatchObject({ status: 'pending' });
  });

  it('marks runs failed when autoWake callback throws', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-1', sessionId: 'session-1' });

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async () => {
        throw new Error('boom');
      },
    });

    await scheduler.tick();
    await scheduler.stop();

    await expect(runStore.get('run-1')).resolves.toMatchObject({ status: 'failed', statusReason: 'boom' });
    expect(eventStore.events.map((event) => event.type)).toEqual(['run_lease_acquired', 'run_state_changed']);
  });

  it('does not emit a fake failed event when lease terminalization loses ownership', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-release-lost', sessionId: 'session-release-lost' });
    vi.spyOn(runStore, 'releaseLease').mockResolvedValue(null);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async () => {
        throw new Error('model resolution failed');
      },
      logger,
    });

    await scheduler.tick();
    await scheduler.stop();

    await expect(runStore.get('run-release-lost')).resolves.toMatchObject({ status: 'running' });
    expect(eventStore.events.map((event) => event.type)).toEqual(['run_lease_acquired']);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(
      'Runtime scheduler wake terminalization failed for run-release-lost: current=running',
    ));
  });

  it('defers recoverable runs before leasing while another brain holds the session', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-busy', sessionId: 'session-busy' });
    const acquireLease = vi.spyOn(runStore, 'acquireLease');
    const canWake = vi.fn(async () => false);
    const wake = vi.fn(async () => undefined);

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      autoWake: true,
      canWake,
      wake,
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();
    await scheduler.tick();
    await flushSchedulerMicrotasks();
    await scheduler.stop();

    expect(canWake).toHaveBeenCalledTimes(1);
    expect(acquireLease).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    const deferredRun = await runStore.get('run-busy');
    expect(deferredRun).toMatchObject({ status: 'pending' });
    expect(deferredRun?.workerId).toBeUndefined();
    expect(deferredRun?.leaseExpiresAt).toBeUndefined();
    expect(eventStore.events).toEqual([]);
  });

  it('releases the run lease without failing when the session becomes busy during wake', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-raced', sessionId: 'session-raced' });
    const wake = vi.fn(async () => {
      throw new Error('Session session-raced 已被另一个 brain 持有，本次 dispatch 退让');
    });

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      autoWake: true,
      canWake: async () => true,
      wake,
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();
    await scheduler.tick();
    await flushSchedulerMicrotasks();
    await scheduler.stop();

    expect(wake).toHaveBeenCalledTimes(1);
    await expect(runStore.get('run-raced')).resolves.toMatchObject({
      status: 'running',
      statusReason: 'session_busy',
      workerId: undefined,
      leaseExpiresAt: undefined,
    });
    expect(eventStore.events.map((event) => event.type)).toEqual(['run_lease_acquired']);
  });

  it('runs different sessions concurrently up to the configured limit', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-1', sessionId: 'session-1' });
    await runStore.upsertPending({ runId: 'run-2', sessionId: 'session-2' });
    await runStore.upsertPending({ runId: 'run-3', sessionId: 'session-3' });
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      maxConcurrentRuns: 2,
      wake: async (record, lease) => {
        started.push(record.runId);
        const gate = deferred();
        gates.set(record.runId, gate);
        await gate.promise;
        await lease.release('completed', 'done');
      },
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();
    expect(started).toEqual(['run-1', 'run-2']);

    gates.get('run-1')?.resolve();
    await flushSchedulerMicrotasks();
    await scheduler.tick();
    await flushSchedulerMicrotasks();
    expect(started).toEqual(['run-1', 'run-2', 'run-3']);

    gates.get('run-2')?.resolve();
    gates.get('run-3')?.resolve();
    await scheduler.stop();
  });

  it('defaults to sixteen concurrent top-level runs', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    for (let index = 1; index <= 17; index += 1) {
      await runStore.upsertPending({
        runId: `run-default-${index}`,
        sessionId: `session-default-${index}`,
      });
    }
    const gate = deferred();
    const started: string[] = [];
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-default-capacity',
      autoWake: true,
      wake: async (record, lease) => {
        started.push(record.runId);
        await gate.promise;
        await lease.release('completed', 'done');
      },
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();

    expect(started).toHaveLength(16);
    expect(started).not.toContain('run-default-17');

    gate.resolve();
    await scheduler.stop();
  });

  it('hot-applies shared capacity without interrupting in-flight runs', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-hot-1', sessionId: 'session-hot-1' });
    await runStore.upsertPending({ runId: 'run-hot-2', sessionId: 'session-hot-2' });
    await runStore.upsertPending({ runId: 'run-hot-3', sessionId: 'session-hot-3' });
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    let desiredMaxConcurrentRuns = 1;
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-hot-capacity',
      autoWake: true,
      maxConcurrentRuns: 1,
      resolveMaxConcurrentRuns: async () => desiredMaxConcurrentRuns,
      wake: async (record, lease) => {
        started.push(record.runId);
        const gate = deferred();
        gates.set(record.runId, gate);
        await gate.promise;
        await lease.release('completed', 'done');
      },
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();
    expect(started).toEqual(['run-hot-1']);
    expect(scheduler.getCapacitySnapshot()).toMatchObject({
      maxConcurrentRuns: 1,
      inFlightRuns: 1,
    });

    desiredMaxConcurrentRuns = 2;
    await scheduler.tick();
    await flushSchedulerMicrotasks();
    expect(started).toEqual(['run-hot-1', 'run-hot-2']);
    expect(scheduler.getCapacitySnapshot()).toMatchObject({
      maxConcurrentRuns: 2,
      inFlightRuns: 2,
    });

    desiredMaxConcurrentRuns = 1;
    await scheduler.tick();
    expect(scheduler.getCapacitySnapshot()).toMatchObject({
      maxConcurrentRuns: 1,
      inFlightRuns: 2,
    });
    expect(started).toHaveLength(2);

    gates.forEach((gate) => gate.resolve());
    await scheduler.stop();
  });

  it('does not let a long run in one session block another session', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-1', sessionId: 'session-1' });
    await runStore.upsertPending({ runId: 'run-2', sessionId: 'session-2' });
    const releaseLongRun = deferred();
    const started: string[] = [];

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      maxConcurrentRuns: 2,
      wake: async (record, lease) => {
        started.push(record.runId);
        if (record.runId === 'run-1') await releaseLongRun.promise;
        await lease.release('completed', 'done');
      },
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();

    expect(started).toEqual(['run-1', 'run-2']);
    await expect(runStore.get('run-2')).resolves.toMatchObject({ status: 'completed' });

    releaseLongRun.resolve();
    await scheduler.stop();
  });

  it('keeps runs in the same session serial', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-1', sessionId: 'session-1' });
    await runStore.upsertPending({ runId: 'run-2', sessionId: 'session-1' });
    const releaseFirstRun = deferred();
    const started: string[] = [];

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      maxConcurrentRuns: 2,
      wake: async (record, lease) => {
        started.push(record.runId);
        if (record.runId === 'run-1') await releaseFirstRun.promise;
        await lease.release('completed', 'done');
      },
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();
    expect(started).toEqual(['run-1']);
    await expect(runStore.get('run-2')).resolves.toMatchObject({ status: 'pending' });

    releaseFirstRun.resolve();
    await flushSchedulerMicrotasks();
    await scheduler.tick();
    await scheduler.stop();

    expect(started).toEqual(['run-1', 'run-2']);
    await expect(runStore.get('run-2')).resolves.toMatchObject({ status: 'completed' });
  });

  it('skips runs when acquireLease returns null without marking them failed', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-1', sessionId: 'session-1' });
    runStore.acquireLease = async () => null;
    let wakeCalled = false;

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async () => {
        wakeCalled = true;
      },
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(wakeCalled).toBe(false);
    await expect(runStore.get('run-1')).resolves.toMatchObject({ status: 'pending' });
    expect(eventStore.events).toHaveLength(0);
  });

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
        await lease.release(undefined, 'background_command_monitor_handoff');
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

  it('uses one shared concurrency pool without task-type reservations', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'bg-1', sessionId: 'sub-1', metadata: { backgroundTask: true } });
    await runStore.upsertPending({ runId: 'bg-2', sessionId: 'sub-2', metadata: { backgroundTask: true } });
    await runStore.upsertPending({ runId: 'bg-3', sessionId: 'sub-3', metadata: { backgroundTask: true } });
    await runStore.upsertPending({ runId: 'normal-1', sessionId: 'session-1' });
    await runStore.upsertPending({ runId: 'normal-2', sessionId: 'session-2' });
    const gate = deferred();
    const started: string[] = [];
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      maxConcurrentRuns: 4,
      wake: async (candidate, lease) => {
        started.push(candidate.runId);
        await gate.promise;
        await lease.release('completed');
      },
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();
    expect(started).toHaveLength(4);
    expect(started).toEqual(['bg-1', 'bg-2', 'bg-3', 'normal-1']);

    gate.resolve();
    await scheduler.stop();
  });

  it('leaves pending runs untouched while memory admission is paused and resumes automatically', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-memory-gated', sessionId: 'session-memory-gated' });
    let admitting = false;
    const gate = deferred();
    const wake = vi.fn(async (_candidate, lease) => {
      await gate.promise;
      await lease.release('completed');
    });
    const admissionGuard = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      canAcquire: () => admitting,
      getSnapshot: () => ({
        state: admitting ? 'healthy' as const : 'paused' as const,
        admitting,
      }),
    };
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      autoWake: true,
      admissionGuard,
      wake,
    });

    await scheduler.tick();
    expect(wake).not.toHaveBeenCalled();
    await expect(runStore.get('run-memory-gated')).resolves.toMatchObject({ status: 'pending' });

    admitting = true;
    await scheduler.tick();
    await flushSchedulerMicrotasks();
    expect(wake).toHaveBeenCalledTimes(1);
    gate.resolve();
    await scheduler.stop();
  });

});
