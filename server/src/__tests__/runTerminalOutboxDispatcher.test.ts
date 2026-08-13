import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunRecord } from '../runtime/runStore.js';
import {
  PgTerminalEventOutboxRunStore,
  type TerminalEventOutboxRunStore,
} from '../runtime/runTerminalOutboxStore.js';
import { TerminalEventOutboxDispatcher } from '../runtime/runTerminalOutboxDispatcher.js';
import type { TerminalEventOutboxRecord } from '../runtime/runTerminalCoordinator.js';
import type { EventAppendContext, EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

function makeRun(
  runId: string,
  state: TerminalEventOutboxRecord['state'] = 'pending',
  tenantId = 'tenant-test',
): RunRecord {
  const deliveryId = `delivery-${runId}`;
  const event = {
    type: 'run_state_changed',
    runId,
    sessionId: `session-${runId}`,
    status: 'completed',
    previousStatus: 'running',
    terminalDeliveryId: deliveryId,
    terminalDeliveryIndex: 0,
  } as PlatformEventInput;
  return {
    runId,
    sessionId: `session-${runId}`,
    tenantId,
    status: 'completed',
    requestedAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    metadata: {
      terminalEventOutbox: {
        version: 1,
        deliveryId,
        tenantId,
        state,
        terminalStatus: 'completed',
        events: [event],
        attempts: 0,
        updatedAt: '2026-08-14T00:00:00.000Z',
      } satisfies TerminalEventOutboxRecord,
    },
  };
}

class DurableRunStore {
  readonly rows = new Map<string, RunRecord>();
  finishFailures = 0;

  constructor(runs: RunRecord[]) {
    for (const run of runs) this.rows.set(run.runId, structuredClone(run));
  }

  async get(runId: string): Promise<RunRecord | null> {
    return this.rows.get(runId) ?? null;
  }

  async listPendingTerminalEventOutboxes(now: Date, staleBefore: Date, limit = 50): Promise<RunRecord[]> {
    return [...this.rows.values()].filter((run) => {
      const outbox = run.metadata.terminalEventOutbox as TerminalEventOutboxRecord | undefined;
      if (
        !outbox
        || outbox.state === 'delivered'
        || outbox.tenantResolutionError
        || run.status !== outbox.terminalStatus
      ) return false;
      if (outbox.state === 'delivering') return !outbox.claimedAt || new Date(outbox.claimedAt) < staleBefore;
      return !outbox.nextAttemptAt || new Date(outbox.nextAttemptAt) <= now;
    }).slice(0, limit);
  }

  async claimTerminalEventOutbox(
    runId: string,
    deliveryId: string,
    claimToken: string,
    now: Date,
    staleBefore: Date,
  ): Promise<RunRecord | null> {
    const run = this.rows.get(runId);
    const outbox = run?.metadata.terminalEventOutbox as TerminalEventOutboxRecord | undefined;
    if (!run || !outbox || outbox.deliveryId !== deliveryId || run.status !== outbox.terminalStatus) return null;
    const authoritativeTenantId = run.tenantId?.trim();
    const durableTenantId = outbox.tenantId?.trim();
    if (!authoritativeTenantId || (durableTenantId && durableTenantId !== authoritativeTenantId)) {
      const diagnostic = !authoritativeTenantId
        ? 'terminal outbox tenant resolution failed: authoritative runtime run/session tenant is missing'
        : 'terminal outbox tenant resolution failed: durable tenant does not match authoritative runtime run tenant';
      run.metadata.terminalEventOutbox = {
        ...outbox,
        state: 'failed',
        lastError: diagnostic,
        tenantResolutionError: diagnostic,
        updatedAt: now.toISOString(),
        nextAttemptAt: undefined,
      };
      return null;
    }
    const due = outbox.state === 'pending' || outbox.state === 'failed'
      ? !outbox.nextAttemptAt || new Date(outbox.nextAttemptAt) <= now
      : outbox.state === 'delivering' && (!outbox.claimedAt || new Date(outbox.claimedAt) < staleBefore);
    if (!due) return null;
    run.metadata.terminalEventOutbox = {
      ...outbox,
      tenantId: authoritativeTenantId,
      state: 'delivering',
      claimToken,
      claimedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextAttemptAt: undefined,
    };
    return run;
  }

  async finishTerminalEventOutbox(
    runId: string,
    deliveryId: string,
    claimToken: string,
    next: Record<string, unknown>,
  ): Promise<RunRecord | null> {
    if (this.finishFailures > 0) {
      this.finishFailures -= 1;
      throw new Error('ack unavailable');
    }
    const run = this.rows.get(runId);
    const outbox = run?.metadata.terminalEventOutbox as TerminalEventOutboxRecord | undefined;
    if (!run || outbox?.deliveryId !== deliveryId || outbox.claimToken !== claimToken) return null;
    run.metadata.terminalEventOutbox = next;
    return run;
  }
}

function makeEventStore(failures = 0) {
  const events: PlatformEvent[] = [];
  let remainingFailures = failures;
  const appendBatch = vi.fn(async (inputs: PlatformEventInput[], _ctx?: EventAppendContext) => {
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error('event store unavailable');
    }
    const stored = inputs.map((input, index) => ({
      id: `event-${events.length + index}`,
      timestamp: new Date().toISOString(),
      ...input,
    })) as PlatformEvent[];
    events.push(...stored);
    return stored;
  });
  return {
    events,
    appendBatch,
    store: {
      append: vi.fn(async (input: PlatformEventInput, ctx?: EventAppendContext) => (
        await appendBatch([input], ctx)
      )[0]!),
      appendBatch,
      list: vi.fn(async (sessionId: string) => events.filter((event) => event.sessionId === sessionId)),
      listByRun: vi.fn(async (sessionId: string, runId: string) => events.filter((event) => (
        event.sessionId === sessionId && 'runId' in event && event.runId === runId
      ))),
    } as EventStore,
  };
}

const dispatchers: TerminalEventOutboxDispatcher[] = [];

afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.stop();
  vi.useRealTimers();
});

function dispatcher(runStore: DurableRunStore, eventStore: EventStore, options: { claimTtlMs?: number } = {}) {
  const value = new TerminalEventOutboxDispatcher({
    runStore: runStore as unknown as TerminalEventOutboxRunStore,
    eventStore,
    scanIntervalMs: 25,
    claimTtlMs: options.claimTtlMs ?? 100,
  });
  dispatchers.push(value);
  return value;
}

describe('TerminalEventOutboxDispatcher', () => {
  it('启动时扫描并恢复 durable terminal outbox', async () => {
    const runs = new DurableRunStore([makeRun('startup')]);
    const events = makeEventStore();

    await dispatcher(runs, events.store).start();

    expect(events.appendBatch).toHaveBeenCalledTimes(1);
    expect((runs.rows.get('startup')!.metadata.terminalEventOutbox as TerminalEventOutboxRecord).state).toBe('delivered');
  });

  it('临时 append 失败后按持久退避自动成功', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    const runs = new DurableRunStore([makeRun('retry')]);
    const events = makeEventStore(1);
    const value = dispatcher(runs, events.store);

    await value.start();
    expect((runs.rows.get('retry')!.metadata.terminalEventOutbox as TerminalEventOutboxRecord).state).toBe('failed');

    await vi.advanceTimersByTimeAsync(525);

    expect(events.appendBatch).toHaveBeenCalledTimes(2);
    expect((runs.rows.get('retry')!.metadata.terminalEventOutbox as TerminalEventOutboxRecord).state).toBe('delivered');
  });

  it('append 成功但 ack 丢失后，重启消费者按 marker 收口且不重复发布', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    const runs = new DurableRunStore([makeRun('restart')]);
    runs.finishFailures = 1;
    const events = makeEventStore();
    const first = dispatcher(runs, events.store, { claimTtlMs: 100 });

    await first.start();
    first.stop();
    expect(events.appendBatch).toHaveBeenCalledTimes(1);
    expect((runs.rows.get('restart')!.metadata.terminalEventOutbox as TerminalEventOutboxRecord).state).toBe('delivering');

    await vi.advanceTimersByTimeAsync(101);
    await dispatcher(runs, events.store, { claimTtlMs: 100 }).start();

    expect(events.appendBatch).toHaveBeenCalledTimes(1);
    expect((runs.rows.get('restart')!.metadata.terminalEventOutbox as TerminalEventOutboxRecord).state).toBe('delivered');
  });

  it('两个消费者并发扫描时仅 CAS 赢家发布', async () => {
    const runs = new DurableRunStore([makeRun('multi')]);
    const events = makeEventStore();
    const first = dispatcher(runs, events.store);
    const second = dispatcher(runs, events.store);

    await Promise.all([first.start(), second.start()]);

    expect(events.appendBatch).toHaveBeenCalledTimes(1);
    expect((runs.rows.get('multi')!.metadata.terminalEventOutbox as TerminalEventOutboxRecord).state).toBe('delivered');
  });

  it('多租户并发恢复时 tenant-a/b 事件只追加到各自租户', async () => {
    const runs = new DurableRunStore([
      makeRun('tenant-a-run', 'pending', 'tenant-a'),
      makeRun('tenant-b-run', 'pending', 'tenant-b'),
    ]);
    const events = makeEventStore();
    const first = dispatcher(runs, events.store);
    const second = dispatcher(runs, events.store);

    await Promise.all([first.start(), second.start()]);

    expect(events.appendBatch).toHaveBeenCalledTimes(2);
    const deliveries = events.appendBatch.mock.calls.map(([inputs, ctx]) => {
      const event = inputs[0];
      return {
        runId: event && 'runId' in event ? event.runId : undefined,
        tenantId: ctx?.tenantId,
      };
    });
    expect(deliveries).toEqual(expect.arrayContaining([
      { runId: 'tenant-a-run', tenantId: 'tenant-a' },
      { runId: 'tenant-b-run', tenantId: 'tenant-b' },
    ]));
    expect(deliveries.every(({ runId, tenantId }) => (
      runId === 'tenant-a-run' ? tenantId === 'tenant-a' : tenantId === 'tenant-b'
    ))).toBe(true);
  });

  it('旧 outbox 缺 tenantId 时从 runtime run 权威 tenant 恢复并持久化', async () => {
    const legacy = makeRun('legacy', 'pending', 'tenant-a');
    delete (legacy.metadata.terminalEventOutbox as TerminalEventOutboxRecord).tenantId;
    const runs = new DurableRunStore([legacy]);
    const events = makeEventStore();

    await dispatcher(runs, events.store).start();

    expect(events.appendBatch).toHaveBeenCalledWith(expect.any(Array), { tenantId: 'tenant-a' });
    expect(runs.rows.get('legacy')!.metadata.terminalEventOutbox).toMatchObject({
      tenantId: 'tenant-a',
      state: 'delivered',
    });
  });

  it('旧 outbox 无法恢复 tenant 时 fail-closed 标记 failed 并保留诊断', async () => {
    const unresolved = makeRun('unresolved');
    delete unresolved.tenantId;
    delete (unresolved.metadata.terminalEventOutbox as TerminalEventOutboxRecord).tenantId;
    const runs = new DurableRunStore([unresolved]);
    const events = makeEventStore();
    const value = dispatcher(runs, events.store);

    await value.start();
    await value.runOnce();

    expect(events.appendBatch).not.toHaveBeenCalled();
    expect(runs.rows.get('unresolved')!.metadata.terminalEventOutbox).toMatchObject({
      state: 'failed',
      tenantResolutionError: expect.stringContaining('authoritative runtime run/session tenant is missing'),
    });
  });

  it('PG outbox row 映射规范化 tenant_id 到 claim DTO 使用的 tenantId', async () => {
    const row = makeRun('pg-row', 'pending', 'tenant-a') as RunRecord & {
      run_id?: string;
      session_id?: string;
      tenant_id?: string;
      requested_at?: string;
      updated_at?: string;
    };
    row.run_id = row.runId;
    row.session_id = row.sessionId;
    row.tenant_id = row.tenantId;
    row.requested_at = row.requestedAt;
    row.updated_at = row.updatedAt;
    delete (row as Partial<RunRecord>).runId;
    delete (row as Partial<RunRecord>).sessionId;
    delete (row as Partial<RunRecord>).tenantId;
    delete (row as Partial<RunRecord>).requestedAt;
    delete (row as Partial<RunRecord>).updatedAt;
    const pool = { query: vi.fn(async () => ({ rows: [{ row_json: row }] })) };
    const store = new PgTerminalEventOutboxRunStore({ pool: pool as never });

    const [mapped] = await store.listPendingTerminalEventOutboxes(
      new Date('2026-08-14T00:00:00.000Z'),
      new Date('2026-08-13T23:59:00.000Z'),
    );

    expect(mapped).toMatchObject({ runId: 'pg-row', sessionId: 'session-pg-row', tenantId: 'tenant-a' });
  });

  it('关闭后清理 timer 且不再扫描', async () => {
    vi.useFakeTimers();
    const runs = new DurableRunStore([]);
    const events = makeEventStore();
    const value = dispatcher(runs, events.store);
    await value.start();

    value.stop();
    runs.rows.set('shutdown', makeRun('shutdown'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(value.isRunning()).toBe(false);
    expect(events.appendBatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
