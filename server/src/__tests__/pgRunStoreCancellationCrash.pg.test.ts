import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PgBillingStore } from '../data/billing/pgBillingStore.js';
import { BillingService } from '../data/billing/service.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';
import { cleanupSteeringPgTest, describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

describePg('PgRunStore cancellation crash PostgreSQL contract', () => {
  const prefix = `cancel_crash_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;
  let eventStore: PgEventStore;
  let toolInvocationStore: PgToolInvocationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    eventStore = new PgEventStore({ connectionString: testPgUrl!, tablePrefix: prefix, poolMax: 4 });
    await eventStore.init();
    store = new PgRunStore({ pool, tablePrefix: prefix, writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true } });
    await store.init();
    toolInvocationStore = new PgToolInvocationStore({ pool, tablePrefix: prefix });
    await toolInvocationStore.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await cleanupSteeringPgTest(pool, eventStore, prefix);
  }, 30_000);

  it('stop 提交后立即崩溃仍在重启后保持 run、终态事件、工具取消与 billing 一致', async () => {
    const sessionId = 'session-stop-post-commit-crash';
    const runId = 'run-stop-post-commit-crash';
    const invocationId = 'invocation-stop-post-commit-crash';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-stop-post-commit-crash',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    const notifyOwner = store as unknown as {
      notifyRuntimeEvents: (client: pg.PoolClient, events: unknown[]) => Promise<void>;
    };
    const notifyRuntimeEvents = notifyOwner.notifyRuntimeEvents;
    notifyOwner.notifyRuntimeEvents = vi.fn(async () => {
      throw new Error('fault_after_cancel_commit');
    });
    try {
      await expect(store.cancelSteeringBeforeDispatchBySessionWithEvent(
        sessionId,
        'web_abort',
        runId,
        { type: 'run_cancel_requested', sessionId, runId, reason: 'web_abort' },
        DEFAULT_TENANT_ID,
      )).rejects.toThrow('fault_after_cancel_commit');
    } finally {
      notifyOwner.notifyRuntimeEvents = notifyRuntimeEvents;
    }

    const restartedStore = new PgRunStore({ pool, tablePrefix: prefix, writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true } });
    const restartedToolStore = new PgToolInvocationStore({ pool, tablePrefix: prefix });
    await Promise.all([restartedStore.init(), restartedToolStore.init()]);
    await expect(restartedStore.get(runId)).resolves.toMatchObject({
      status: 'cancelled',
      statusReason: 'web_abort',
    });
    await expect(restartedToolStore.get(invocationId)).resolves.toMatchObject({
      status: 'running',
      cancelRequestedAt: expect.any(String),
      cancelReason: 'web_abort',
    });

    const durableEvents = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durableEvents.filter((item) => item.type === 'run_cancel_requested')).toHaveLength(1);
    expect(durableEvents.filter((item) => item.type === 'tool_invocation_cancel_requested')).toHaveLength(1);
    expect(durableEvents.filter((item) => item.type === 'run_state_changed')).toEqual([
      expect.objectContaining({
        type: 'run_state_changed',
        runId,
        status: 'cancelled',
        previousStatus: 'running',
        reason: 'web_abort',
      }),
    ]);

    const persisted = await pool.query<{
      global_sequence: string;
      event_id: string;
      event_type: string;
      tenant_id: string;
      timestamp: Date;
      event_json: Record<string, unknown>;
    }>(`
      SELECT global_sequence, event_id, event_type, tenant_id, timestamp, event_json
      FROM ${prefix}_events
      WHERE session_id = $1
      ORDER BY global_sequence
    `, [sessionId]);
    const settleRunDebit = vi.fn(async () => null);
    const billingStore = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => persisted.rows.map((row) => ({
        globalSequence: Number(row.global_sequence),
        eventId: row.event_id,
        eventType: row.event_type,
        tenantId: row.tenant_id,
        timestamp: new Date(row.timestamp).toISOString(),
        eventJson: row.event_json,
      }))),
      settleRunDebit,
      setProjectionState: vi.fn(async () => undefined),
    } as unknown as PgBillingStore;
    await new BillingService({ store: billingStore }).projectRuntimeEvents();
    expect(settleRunDebit).toHaveBeenCalledTimes(1);
    expect(settleRunDebit).toHaveBeenCalledWith(DEFAULT_TENANT_ID, runId);

    const nextRunId = 'run-stop-post-commit-crash-next';
    await restartedStore.upsertPending({ runId: nextRunId, sessionId, userId: 'user-1', channel: 'web' });
    await restartedStore.markStatus(nextRunId, 'running');
    await expect(restartedStore.cancelSteeringBeforeDispatchBySessionWithEvent(
      sessionId,
      'web_abort',
      runId,
      { type: 'run_cancel_requested', sessionId, runId, reason: 'web_abort' },
      DEFAULT_TENANT_ID,
    )).resolves.toMatchObject({ targetCancelled: false, eventCreated: false });
    await expect(restartedStore.get(nextRunId)).resolves.toMatchObject({ status: 'running' });
    const replayedEvents = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(replayedEvents.filter((item) => item.type === 'run_state_changed')).toHaveLength(1);
  });
});
