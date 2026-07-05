import { describe, expect, it } from 'vitest';

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

  async acquireLease(runId: string, workerId: string, leaseMs: number): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || !['pending', 'running'].includes(record.status)) return null;
    const updated: RunRecord = {
      ...record,
      status: 'running',
      workerId,
      leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
      updatedAt: new Date().toISOString(),
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
});
