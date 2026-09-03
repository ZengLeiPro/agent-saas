import { describe, expect, it } from 'vitest';

import {
  projectRunLiveness,
  RUN_LIVENESS_VERSION,
  type LivenessReapResult,
  type RunHeartbeatSource,
} from '../runtime/runLiveness.js';
import type { RunRecord, RunStatus, RunStore, UpsertRunInput } from '../runtime/runStore.js';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

class FakeClock {
  constructor(private value: number = Date.parse('2026-08-30T00:00:00.000Z')) {}
  now = (): Date => new Date(this.value);
  advance(ms: number): void { this.value += ms; }
}

/** Deterministic contract double; every transition uses the injected fake clock. */
class AuthoritativeMemoryRunStore implements RunStore {
  readonly records = new Map<string, RunRecord>();
  readonly clientRuns = new Map<string, string>();
  readonly unsafeToolRuns = new Set<string>(); // simulates durable running tool invocations
  readonly terminalizations = new Map<string, number>();

  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const existing = this.records.get(input.runId);
    if (existing) return existing;
    const now = (input.metadata?.now as string | undefined) ?? '2026-08-30T00:00:00.000Z';
    const record: RunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      userId: input.userId,
      submitterUserId: input.submitterUserId,
      tenantId: input.tenantId ?? 'tenant-test',
      status: 'pending',
      requestedAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ?? {},
      liveness: {
        state: 'active', recoveryActions: ['cancel'], detectedAt: now, version: RUN_LIVENESS_VERSION,
      },
    };
    this.records.set(record.runId, record);
    if (record.idempotencyKey) this.clientRuns.set(`${record.submitterUserId ?? record.userId ?? '__anonymous__'}:${record.idempotencyKey}`, record.runId);
    return record;
  }

  async markStatus(runId: string, status: RunStatus, reason?: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    if (['completed', 'failed', 'cancelled', 'orphaned'].includes(record.status) && record.status !== status) return record;
    const state = status === 'orphaned' ? 'orphaned'
      : ['completed', 'failed', 'cancelled'].includes(status) ? 'terminal'
        : ['waiting_user', 'waiting_approval'].includes(status) ? 'waiting_interaction'
          : status === 'running' || status === 'waiting_hand' ? 'busy' : 'active';
    const detectedAt = record.updatedAt;
    const updated: RunRecord = {
      ...record,
      status,
      statusReason: reason,
      workerId: ['waiting_user', 'waiting_approval', 'completed', 'failed', 'cancelled', 'orphaned'].includes(status) ? undefined : record.workerId,
      leaseExpiresAt: ['waiting_user', 'waiting_approval', 'completed', 'failed', 'cancelled', 'orphaned'].includes(status) ? undefined : record.leaseExpiresAt,
      liveness: {
        state, reasonCode: reason, detectedAt,
        lastHeartbeatAt: record.liveness?.lastHeartbeatAt,
        ownerId: record.workerId,
        leaseExpiresAt: record.leaseExpiresAt,
        recoveryActions: state === 'terminal' ? [] : state === 'orphaned' ? ['retry', 'cancel'] : ['cancel'],
        version: (record.liveness?.version ?? 0) + 1,
      },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async get(runId: string): Promise<RunRecord | null> { return this.records.get(runId) ?? null; }
  async findByIdempotencyKey(userId: string | undefined, key: string): Promise<RunRecord | null> {
    const runId = this.clientRuns.get(`${userId ?? '__anonymous__'}:${key}`);
    return runId ? this.get(runId) : null;
  }
  async listRecoverable(): Promise<RunRecord[]> {
    return [...this.records.values()].filter((record) => record.status === 'pending');
  }

  async acquireLease(
    runId: string, workerId: string, leaseMs: number, now = new Date(), _maxConcurrentRuns?: number,
    _admission?: RunLeaseAdmission, _identity?: RunLeaseIdentity, leaseToken?: string,
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.status !== 'pending') return null;
    const blocked = [...this.records.values()].some((candidate) => candidate.runId !== runId
      && candidate.sessionId === record.sessionId && ['running', 'waiting_hand'].includes(candidate.status));
    if (blocked) return null;
    const iso = now.toISOString();
    const expiry = new Date(now.getTime() + leaseMs).toISOString();
    const updated: RunRecord = {
      ...record, status: 'running', workerId, leaseExpiresAt: expiry, updatedAt: iso,
      metadata: { ...record.metadata, ...(leaseToken ? { runLeaseToken: leaseToken } : {}) },
      liveness: {
        state: 'busy', lastHeartbeatAt: iso, leaseExpiresAt: expiry, ownerId: workerId,
        recoveryActions: ['cancel'], detectedAt: iso, version: (record.liveness?.version ?? 0) + 1,
      },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async renewLease(
    runId: string, workerId: string, leaseMs: number, now = new Date(), source: RunHeartbeatSource = 'worker', leaseToken?: string,
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.status !== 'running' || record.workerId !== workerId || !record.liveness
      || record.liveness.state === 'stale' || (leaseToken && record.metadata?.runLeaseToken !== leaseToken)) return null;
    const expiry = new Date(now.getTime() + leaseMs).toISOString();
    const updated: RunRecord = {
      ...record, leaseExpiresAt: expiry, updatedAt: now.toISOString(),
      liveness: {
        state: 'busy', lastHeartbeatAt: now.toISOString(), leaseExpiresAt: expiry, ownerId: workerId,
        reasonCode: `heartbeat_${source}`, recoveryActions: ['cancel'],
        detectedAt: record.liveness.detectedAt, version: record.liveness.version + 1,
      },
    };
    this.records.set(runId, updated);
    return updated;
  }

  heartbeatRun(runId: string, workerId: string, leaseMs: number, source: RunHeartbeatSource, now = new Date()): Promise<RunRecord | null> {
    return this.renewLease(runId, workerId, leaseMs, now, source);
  }

  async markLivenessStale(runId: string, workerId: string, reasonCode: string, now = new Date()): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.status !== 'running' || record.workerId !== workerId || record.liveness?.state !== 'busy') return null;
    const updated: RunRecord = {
      ...record, updatedAt: now.toISOString(),
      liveness: { ...record.liveness, state: 'stale', reasonCode, recoveryActions: ['cancel'], detectedAt: now.toISOString(), version: record.liveness.version + 1 },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async reapExpiredLiveness(now: Date, staleGraceMs: number): Promise<LivenessReapResult> {
    const orphaned: RunRecord[] = [];
    const stale: RunRecord[] = [];
    for (const record of [...this.records.values()]) {
      if (record.status !== 'running' || record.liveness?.state !== 'stale') continue;
      if (Date.parse(record.liveness.detectedAt ?? record.updatedAt) > now.getTime() - staleGraceMs) continue;
      const unsafe = this.unsafeToolRuns.has(record.runId);
      const updated: RunRecord = {
        ...record, status: 'orphaned', statusReason: unsafe ? 'external_tool_outcome_unknown' : 'lease_expired',
        workerId: undefined, leaseExpiresAt: undefined, updatedAt: now.toISOString(),
        liveness: {
          ...record.liveness, state: 'orphaned', reasonCode: unsafe ? 'external_tool_outcome_unknown' : 'lease_expired',
          ownerId: undefined, leaseExpiresAt: undefined, recoveryActions: unsafe ? ['cancel'] : ['retry', 'cancel'],
          detectedAt: now.toISOString(), version: record.liveness.version + 1,
        },
      };
      this.records.set(record.runId, updated);
      this.terminalizations.set(record.runId, (this.terminalizations.get(record.runId) ?? 0) + 1);
      orphaned.push(updated);
    }
    for (const record of [...this.records.values()]) {
      if (record.status !== 'running' || record.liveness?.state !== 'busy') continue;
      if (!record.leaseExpiresAt || Date.parse(record.leaseExpiresAt) > now.getTime()) continue;
      const updated = await this.markLivenessStale(record.runId, record.workerId!, 'lease_expired', now);
      if (updated) stale.push(updated);
    }
    return { stale, orphaned };
  }

  async retryOrphanedUserMessage(userId: string | undefined, clientMsgId: string, now = new Date()): Promise<RunRecord | null> {
    const record = await this.findByIdempotencyKey(userId, clientMsgId);
    if (!record || this.unsafeToolRuns.has(record.runId)) return null;
    if (record.status === 'pending' && record.statusReason === 'explicit_client_retry') return record;
    if (record.status !== 'orphaned') return null;
    const retryRunId = `retry-${record.runId}`;
    const updated: RunRecord = {
      ...record, runId: retryRunId, status: 'pending', statusReason: 'explicit_client_retry', updatedAt: now.toISOString(),
      metadata: { ...record.metadata, retryOf: record.runId, explicitRetryAt: now.toISOString() },
      liveness: { state: 'active', reasonCode: 'explicit_client_retry', recoveryActions: ['cancel'], detectedAt: now.toISOString(), version: 1 },
    };
    this.records.set(retryRunId, updated);
    this.records.set(record.runId, { ...record, metadata: { ...record.metadata, explicitRetryRunId: retryRunId } });
    this.clientRuns.set(`${userId ?? '__anonymous__'}:${clientMsgId}`, retryRunId);
    return updated;
  }

  async cancelUserMessageByClientMsgId(userId: string | undefined, clientMsgId: string, reason = 'explicit_client_cancel', now = new Date()): Promise<RunRecord | null> {
    const record = await this.findByIdempotencyKey(userId, clientMsgId);
    if (!record) return null;
    if (['completed', 'failed', 'cancelled', 'orphaned'].includes(record.status)) return record;
    const updated: RunRecord = {
      ...record, status: 'cancelled', statusReason: reason, workerId: undefined, leaseExpiresAt: undefined, updatedAt: now.toISOString(),
      liveness: { state: 'terminal', reasonCode: reason, recoveryActions: [], detectedAt: now.toISOString(), version: (record.liveness?.version ?? 0) + 1 },
    };
    this.records.set(record.runId, updated);
    return updated;
  }
}

async function createRunning(store: AuthoritativeMemoryRunStore, clock: FakeClock, runId = 'run-1', sessionId = 'session-1'): Promise<RunRecord> {
  await store.upsertPending({ runId, sessionId, userId: 'user-1', submitterUserId: 'user-1', idempotencyKey: `client-${runId}`, metadata: { now: clock.now().toISOString() } });
  return (await store.acquireLease(runId, 'worker-1', 1_000, clock.now()))!;
}

describe('M40-02 authoritative run liveness kernel', () => {
  it('keeps legacy rows without a liveness version unknown instead of guessing', () => {
    expect(projectRunLiveness({ status: 'running', statusReason: undefined, workerId: 'legacy', leaseExpiresAt: '2020-01-01T00:00:00.000Z' }))
      .toEqual({ state: 'unknown', recoveryActions: [], version: 0 });
  });

  it('moves active to busy with authoritative heartbeat, owner and lease fields', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    const run = await createRunning(store, clock);
    expect(projectRunLiveness(run)).toMatchObject({ state: 'busy', ownerId: 'worker-1', lastHeartbeatAt: clock.now().toISOString(), version: 2 });
  });

  it.each(['stream', 'tool', 'subagent'] as const)('renews a long busy run from %s activity without wall-clock timeout', async (source) => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock);
    clock.advance(900);
    const pulse = await store.heartbeatRun('run-1', 'worker-1', 1_000, source, clock.now());
    clock.advance(900);
    const reaped = await store.reapExpiredLiveness(clock.now(), 500);
    expect(reaped).toEqual({ stale: [], orphaned: [] });
    expect(pulse?.liveness).toMatchObject({ state: 'busy', reasonCode: `heartbeat_${source}` });
  });

  it.each(['waiting_approval', 'waiting_user'] as const)('does not apply busy lease timeout to %s', async (status) => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock);
    await store.markStatus('run-1', status, status === 'waiting_user' ? 'ask_user' : 'approval');
    clock.advance(86_400_000);
    expect(await store.reapExpiredLiveness(clock.now(), 500)).toEqual({ stale: [], orphaned: [] });
    expect(projectRunLiveness((await store.get('run-1'))!)).toMatchObject({ state: 'waiting_interaction' });
  });

  it('fences a disconnected worker and does not let a restart heartbeat revive stale ownership', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock);
    await store.markLivenessStale('run-1', 'worker-1', 'worker_disconnected', clock.now());
    expect(await store.heartbeatRun('run-1', 'worker-1', 1_000, 'worker', clock.now())).toBeNull();
    expect(await store.heartbeatRun('run-1', 'worker-restart', 1_000, 'worker', clock.now())).toBeNull();
  });

  it('uses fake time for mandatory two-phase stale then orphaned detection', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock);
    clock.advance(1_001);
    const first = await store.reapExpiredLiveness(clock.now(), 500);
    expect(first.stale).toHaveLength(1); expect(first.orphaned).toHaveLength(0);
    clock.advance(499);
    expect((await store.reapExpiredLiveness(clock.now(), 500)).orphaned).toHaveLength(0);
    clock.advance(1);
    expect((await store.reapExpiredLiveness(clock.now(), 500)).orphaned).toHaveLength(1);
  });

  it('lets multiple reapers CAS-terminalize only once', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock); clock.advance(1_001); await store.reapExpiredLiveness(clock.now(), 100); clock.advance(100);
    const results = await Promise.all([store.reapExpiredLiveness(clock.now(), 100), store.reapExpiredLiveness(clock.now(), 100), store.reapExpiredLiveness(clock.now(), 100)]);
    expect(results.reduce((count, result) => count + result.orphaned.length, 0)).toBe(1);
    expect(store.terminalizations.get('run-1')).toBe(1);
  });

  it('keeps terminal state sticky against late worker updates', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock); await store.markStatus('run-1', 'completed', 'done');
    await store.markStatus('run-1', 'running', 'late-worker');
    expect(await store.heartbeatRun('run-1', 'worker-1', 1_000, 'stream', clock.now())).toBeNull();
    expect(await store.get('run-1')).toMatchObject({ status: 'completed' });
  });

  it('lets the real scheduler advance a queue only after the reaper durably terminalizes its blocker', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock, 'run-1', 'session-scheduler-q');
    await store.upsertPending({ runId: 'run-2', sessionId: 'session-scheduler-q', metadata: { now: clock.now().toISOString() } });
    const events: PlatformEvent[] = [];
    const eventStore: EventStore = {
      append: async (input: PlatformEventInput) => {
        const event = { ...input, id: `event-${events.length + 1}`, timestamp: clock.now().toISOString() } as PlatformEvent;
        events.push(event); return event;
      },
      list: async () => events,
    };
    const started: string[] = [];
    const scheduler = new RuntimeScheduler({
      runStore: store, eventStore, workerId: 'scheduler-worker', now: clock.now,
      leaseMs: 1_000, livenessStaleGraceMs: 500, autoWake: true,
      wake: async (record) => { started.push(record.runId); await store.markStatus(record.runId, 'completed', 'done'); },
    });
    clock.advance(1_001); await scheduler.tick(); await scheduler.stop();
    expect(started).toEqual([]);
    clock.advance(500); await scheduler.tick(); await scheduler.stop();
    expect(started).toEqual(['run-2']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'run_state_changed', runId: 'run-1', status: 'orphaned' }));
  });

  it('advances a same-session queue only after durable orphan terminalization', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock, 'run-1', 'session-q');
    await store.upsertPending({ runId: 'run-2', sessionId: 'session-q', metadata: { now: clock.now().toISOString() } });
    clock.advance(1_001); await store.reapExpiredLiveness(clock.now(), 500);
    expect(await store.acquireLease('run-2', 'worker-2', 1_000, clock.now())).toBeNull();
    clock.advance(500); await store.reapExpiredLiveness(clock.now(), 500);
    expect(await store.acquireLease('run-2', 'worker-2', 1_000, clock.now())).toMatchObject({ status: 'running' });
  });

  it('never auto-replays uncertain external tool outcomes, refuses retry, and permits explicit cancel', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock); store.unsafeToolRuns.add('run-1');
    clock.advance(1_001); await store.reapExpiredLiveness(clock.now(), 100); clock.advance(100); await store.reapExpiredLiveness(clock.now(), 100);
    expect(await store.listRecoverable()).toEqual([]);
    expect(await store.retryOrphanedUserMessage('user-1', 'client-run-1', clock.now())).toBeNull();
    expect(projectRunLiveness((await store.get('run-1'))!)).toMatchObject({ state: 'orphaned', reasonCode: 'external_tool_outcome_unknown', recoveryActions: ['cancel'] });
  });

  it('makes same-clientMsgId explicit retry and cancel idempotent', async () => {
    const clock = new FakeClock(); const store = new AuthoritativeMemoryRunStore();
    await createRunning(store, clock); clock.advance(1_001); await store.reapExpiredLiveness(clock.now(), 100); clock.advance(100); await store.reapExpiredLiveness(clock.now(), 100);
    const retry1 = await store.retryOrphanedUserMessage('user-1', 'client-run-1', clock.now());
    const retry2 = await store.retryOrphanedUserMessage('user-1', 'client-run-1', clock.now());
    expect(retry2?.runId).toBe(retry1?.runId);
    expect(await store.get('run-1')).toMatchObject({ status: 'orphaned' });
    const cancel1 = await store.cancelUserMessageByClientMsgId('user-1', 'client-run-1', 'explicit_cancel', clock.now());
    const cancel2 = await store.cancelUserMessageByClientMsgId('user-1', 'client-run-1', 'explicit_cancel', clock.now());
    expect(cancel2).toEqual(cancel1);
    expect(cancel1).toMatchObject({ status: 'cancelled' });
  });
});
