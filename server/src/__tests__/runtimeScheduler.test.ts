import { describe, expect, it, vi } from 'vitest';

import { RuntimeScheduler } from '../runtime/scheduler.js';
import type { RunRecord, RunStatus, RunStore, UpsertRunInput } from '../runtime/runStore.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

class MemoryRunStore implements RunStore {
  records = new Map<string, RunRecord>();

  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      userId: input.userId,
      tenantId: input.tenantId,
      status: 'pending',
      model: input.model,
      channel: input.channel,
      requestedAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
      executionTarget: input.executionTarget,
      workspaceId: input.workspaceId,
      metadata: input.metadata ?? {},
    };
    this.records.set(record.runId, record);
    return record;
  }

  async markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    const updated = { ...record, status, statusReason: reason, updatedAt: new Date().toISOString(), metadata: { ...record.metadata, ...metadataPatch } };
    this.records.set(runId, updated);
    return updated;
  }

  async get(runId: string): Promise<RunRecord | null> { return this.records.get(runId) ?? null; }

  async findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) =>
      record.idempotencyKey === idempotencyKey && record.userId === userId,
    ) ?? null;
  }

  async listRecoverable(): Promise<RunRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'pending' || record.status === 'running')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async listStaleWaitingApproval(cutoff: Date, limit = 50): Promise<RunRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'waiting_approval' && new Date(record.updatedAt) < cutoff)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }

  async cancelStaleWaitingApproval(
    runId: string,
    cutoff: Date,
    reason: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.status !== 'waiting_approval' || new Date(record.updatedAt) >= cutoff) return null;
    const now = new Date().toISOString();
    const updated: RunRecord = {
      ...record,
      status: 'cancelled',
      statusReason: reason,
      updatedAt: now,
      cancelledAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async acquireLease(runId: string, workerId: string, leaseMs: number, now = new Date()): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    // 忠实复刻 pgRunStore.acquireLease 的原子 CAS 守卫（runStore.ts:433-437）：
    //   status='pending' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at < now))
    // 只有满足其一才能夺得 lease；running 且 lease 未过期 → 返回 null（互斥）。
    const leaseExpired =
      record.leaseExpiresAt === undefined ||
      record.leaseExpiresAt === null ||
      new Date(record.leaseExpiresAt) < now;
    const acquirable = record.status === 'pending' || (record.status === 'running' && leaseExpired);
    if (!acquirable) return null;
    const updated: RunRecord = {
      ...record,
      status: 'running',
      workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    this.records.set(runId, updated);
    return updated;
  }

  async renewLease(runId: string, workerId: string, leaseMs: number): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.workerId !== workerId) return null;
    const updated = { ...record, leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() };
    this.records.set(runId, updated);
    return updated;
  }

  async releaseLease(runId: string, workerId: string, finalStatus?: RunStatus, reason?: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.workerId !== workerId) return null;
    const updated: RunRecord = {
      ...record,
      status: finalStatus ?? record.status,
      statusReason: reason,
      workerId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(runId, updated);
    return updated;
  }
}

class MemoryEventStore implements EventStore {
  events: PlatformEvent[] = [];
  appendContexts: Array<Parameters<EventStore['append']>[1]> = [];
  async append(event: PlatformEventInput, ctx?: Parameters<EventStore['append']>[1]): Promise<PlatformEvent> {
    const full = { ...event, id: `e${this.events.length + 1}`, timestamp: new Date().toISOString() } as PlatformEvent;
    this.appendContexts.push(ctx);
    this.events.push(full);
    return full;
  }
  async list(sessionId: string): Promise<PlatformEvent[]> { return this.events.filter((event) => event.sessionId === sessionId); }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushSchedulerMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('RuntimeScheduler', () => {
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

  it('prioritizes normal runs and limits background execution to reserved slots', async () => {
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
      maxConcurrentBackgroundRuns: 2,
      wake: async (candidate, lease) => {
        started.push(candidate.runId);
        await gate.promise;
        await lease.release('completed');
      },
    });

    await scheduler.tick();
    await flushSchedulerMicrotasks();
    expect(started).toHaveLength(4);
    expect(started).toEqual(expect.arrayContaining(['normal-1', 'normal-2']));
    expect(started.filter((runId) => runId.startsWith('bg-'))).toHaveLength(2);

    gate.resolve();
    await scheduler.stop();
  });

  // P0-1 回归：pgRunStore.acquireLease 原子 CAS 互斥（核实-runtime-cron并发.md 闭合层 1）。
  // 锁死"两 worker 并发 acquire 同一 runId 恰好一个成功"——防未来把真 CAS mock 退化成假绿。
  describe('P0-1 acquireLease CAS mutual exclusion', () => {
    it('lets only one of two concurrent workers acquire the same runId', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-cas', sessionId: 'session-cas' });

      // 两个不同 workerId 并发 CAS 同一 runId（模拟蓝绿两实例竞争 lease）。
      const [a, b] = await Promise.all([
        runStore.acquireLease('run-cas', 'worker-A', 60_000),
        runStore.acquireLease('run-cas', 'worker-B', 60_000),
      ]);

      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      // 记录里的 lease 归属于唯一赢家，输家拿到 null。
      const persisted = await runStore.get('run-cas');
      expect(persisted?.status).toBe('running');
      expect(['worker-A', 'worker-B']).toContain(persisted?.workerId);
      expect(winners[0]?.workerId).toBe(persisted?.workerId);
    });

    it('rejects a second acquire while the lease is still valid', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-held', sessionId: 'session-held' });

      const first = await runStore.acquireLease('run-held', 'worker-A', 60_000);
      expect(first?.workerId).toBe('worker-A');

      // lease 未过期 → 第二个 worker 的 CAS 不匹配 WHERE 守卫 → null。
      const second = await runStore.acquireLease('run-held', 'worker-B', 60_000);
      expect(second).toBeNull();
      await expect(runStore.get('run-held')).resolves.toMatchObject({ workerId: 'worker-A' });
    });

    it('lets a new worker take over after the previous lease expires, and the old worker renewLease fails triggering abort', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-takeover', sessionId: 'session-takeover' });

      // worker-A 先拿到一个短 lease。
      const baseNow = new Date('2026-07-18T00:00:00.000Z');
      const leaseA = await runStore.acquireLease('run-takeover', 'worker-A', 1_000, baseNow);
      expect(leaseA?.workerId).toBe('worker-A');

      // lease 未过期时 worker-B 抢不到。
      const beforeExpiry = new Date(baseNow.getTime() + 500);
      expect(await runStore.acquireLease('run-takeover', 'worker-B', 60_000, beforeExpiry)).toBeNull();

      // lease 过期后 worker-B CAS 成功，改写 worker_id。
      const afterExpiry = new Date(baseNow.getTime() + 2_000);
      const leaseB = await runStore.acquireLease('run-takeover', 'worker-B', 60_000, afterExpiry);
      expect(leaseB?.workerId).toBe('worker-B');

      // 旧 worker-A 的续租链路：renewLease 因 worker_id 已被改写而返回 null。
      const renewedA = await runStore.renewLease('run-takeover', 'worker-A', 60_000);
      expect(renewedA).toBeNull();

      // 对照核实文件"续租失败链路 abortController.abort()"：续租失败即触发旧 in-flight run 中止。
      const abortController = new AbortController();
      if (renewedA === null) abortController.abort();
      expect(abortController.signal.aborted).toBe(true);
    });

    it('aborts the preempted old run through the wake lease.renew() failure path', async () => {
      // 端到端串起 scheduler：worker-A 在 wake 中执行，被 worker-B 抢占 lease 后
      // lease.renew() 抛错，wake 内的 abortController 被 abort（旧 run 主动中止，而非双跑）。
      const runStore = new MemoryRunStore();
      const eventStore = new MemoryEventStore();
      await runStore.upsertPending({ runId: 'run-preempt', sessionId: 'session-preempt' });

      const wakeEntered = deferred();
      const preempted = deferred();
      const abortController = new AbortController();
      let renewError: unknown;

      const scheduler = new RuntimeScheduler({
        runStore,
        eventStore,
        workerId: 'worker-A',
        autoWake: true,
        wake: async (record, lease) => {
          wakeEntered.resolve();
          // 等待外部把 lease 抢占（模拟 worker-B 接管 + lease 过期）。
          await preempted.promise;
          try {
            await lease.renew();
          } catch (err) {
            // 复刻 startWakeLeaseRenewal 的 catch：续租失败 → 中止旧 run。
            renewError = err;
            abortController.abort();
          }
          await lease.release('cancelled', 'preempted');
        },
      });

      const tick = scheduler.tick();
      await wakeEntered.promise;

      // worker-B 抢占：手动过期 worker-A 的 lease 后由 worker-B CAS 接管。
      const current = await runStore.get('run-preempt');
      runStore.records.set('run-preempt', { ...current!, leaseExpiresAt: new Date(Date.now() - 1).toISOString() });
      const takeover = await runStore.acquireLease('run-preempt', 'worker-B', 60_000);
      expect(takeover?.workerId).toBe('worker-B');

      preempted.resolve();
      await tick;
      await scheduler.stop();

      expect(renewError).toBeInstanceOf(Error);
      expect(abortController.signal.aborted).toBe(true);
    });
  });
});
