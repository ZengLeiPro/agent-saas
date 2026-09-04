import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { finalizeTerminalRun, readTerminalEventOutbox } from '../runtime/runTerminalCoordinator.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';
import {
  cleanupSteeringPgTest,
  describePg,
  testPgUrl,
  waitForBlockedQuery,
} from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

describePg('runtime drain handoff PostgreSQL contract', () => {
  const prefix = `drain_handoff_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;
  let eventStore: PgEventStore;
  let toolInvocationStore: PgToolInvocationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    eventStore = new PgEventStore({
      connectionString: testPgUrl!,
      tablePrefix: prefix,
      poolMax: 4,
    });
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

  it('原子交接保持 running、避开 reaper，并且并发新 Worker 只有一个取得所有权', async () => {
    const runId = 'run-atomic-handoff';
    await store.upsertPending({ runId, sessionId: 'session-atomic-handoff' });
    await expect(store.acquireLease(runId, 'worker-old', 60_000)).resolves.toMatchObject({
      workerId: 'worker-old',
      liveness: { state: 'busy' },
    });

    await expect(
      store.releaseLease(runId, 'worker-old', undefined, 'server_drain_handoff', {
        handoff: true,
        metadataPatch: { drainHandoffAt: new Date().toISOString() },
      }),
    ).resolves.toMatchObject({
      status: 'running',
      statusReason: 'server_drain_handoff',
      workerId: undefined,
      leaseExpiresAt: undefined,
      metadata: { drainHandoffReady: true },
    });
    expect((await store.get(runId))?.liveness).toBeUndefined();

    const reaped = await store.reapExpiredLiveness(new Date(Date.now() + 3_600_000), 0);
    expect(reaped.orphaned).toEqual([]);
    expect((await store.listRecoverable()).map((run) => run.runId)).toContain(runId);

    const contenders = await Promise.all([
      store.acquireLease(runId, 'worker-new-a', 60_000),
      store.acquireLease(runId, 'worker-new-b', 60_000),
    ]);
    expect(contenders.filter(Boolean)).toHaveLength(1);
    expect((await store.get(runId))?.liveness?.state).toBe('busy');
    expect(['worker-new-a', 'worker-new-b']).toContain((await store.get(runId))?.workerId);
  });

  it('存在 running tool invocation 时拒绝交接，避免未知外部副作用被重放', async () => {
    const runId = 'run-tool-in-flight';
    const sessionId = 'session-tool-in-flight';
    await store.upsertPending({ runId, sessionId });
    await store.acquireLease(runId, 'worker-tool', 60_000);
    await toolInvocationStore.start({
      invocationId: 'invocation-tool-in-flight',
      runId,
      sessionId,
      toolCallId: 'call-tool-in-flight',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    await expect(
      store.releaseLease(runId, 'worker-tool', undefined, 'server_drain_handoff', {
        handoff: true,
      }),
    ).resolves.toBeNull();
    await expect(store.get(runId)).resolves.toMatchObject({
      status: 'running',
      workerId: 'worker-tool',
      liveness: { state: 'busy' },
    });
  });

  it('tool start 先持有共享锁并写入时，handoff 等锁后能看到新 invocation 并拒绝交接', async () => {
    const runId = 'run-tool-start-race';
    const sessionId = 'session-tool-start-race';
    await store.upsertPending({ runId, sessionId });
    await store.acquireLease(runId, 'worker-tool-race', 60_000);

    const toolStarter = await pool.connect();
    let handoff: ReturnType<PgRunStore['releaseLease']> | undefined;
    try {
      await toolStarter.query('BEGIN');
      await toolStarter.query(`SELECT run_id FROM ${prefix}_runs WHERE run_id = $1 FOR SHARE`, [
        runId,
      ]);
      await toolStarter.query(
        `
        INSERT INTO ${prefix}_tool_invocations
          (invocation_id, run_id, session_id, tool_call_id, tool_name, execution_target, status, started_at, updated_at)
        VALUES ('invocation-tool-start-race', $1, $2, 'call-tool-start-race', 'Shell', 'server-remote', 'running', clock_timestamp(), clock_timestamp())
      `,
        [runId, sessionId],
      );
      handoff = store.releaseLease(runId, 'worker-tool-race', undefined, 'server_drain_handoff', {
        handoff: true,
      });
      await waitForBlockedQuery(pool, `%SELECT run_id FROM ${prefix}_runs%FOR UPDATE%`);
      await toolStarter.query('COMMIT');
      await expect(handoff).resolves.toBeNull();
      await expect(store.get(runId)).resolves.toMatchObject({ workerId: 'worker-tool-race' });
    } finally {
      await toolStarter.query('ROLLBACK').catch(() => undefined);
      toolStarter.release();
      await handoff?.catch(() => undefined);
    }
  });

  it('交接先提交时，迟到的 tool start 原子落为 failed，不会把接续队列永久堵住', async () => {
    const runId = 'run-late-tool-start';
    const sessionId = 'session-late-tool-start';
    await store.upsertPending({ runId, sessionId });
    await store.acquireLease(runId, 'worker-late-tool', 60_000);
    await store.releaseLease(runId, 'worker-late-tool', undefined, 'server_drain_handoff', {
      handoff: true,
    });

    await expect(
      toolInvocationStore.start({
        invocationId: 'invocation-late-tool-start',
        runId,
        sessionId,
        toolCallId: 'call-late-tool-start',
        toolName: 'Shell',
        executionTarget: 'server-remote',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: 'run_handoff_ready_before_tool_start',
    });
    expect((await store.listRecoverable()).map((run) => run.runId)).toContain(runId);
  });

  it('首次发布仍接得住 N-1 留下的明确旧式交接行，但普通 stale 继续由 reaper 终态化', async () => {
    const legacyRunId = 'run-legacy-handoff';
    await store.upsertPending({ runId: legacyRunId, sessionId: 'session-legacy-handoff' });
    await store.acquireLease(legacyRunId, 'worker-legacy', 60_000);
    await store.markStatus(legacyRunId, 'running', 'server_drain_handoff', {
      drainHandoffAt: new Date().toISOString(),
    });
    await store.releaseLease(legacyRunId, 'worker-legacy', undefined, 'server_drain_handoff');
    await expect(store.get(legacyRunId)).resolves.toMatchObject({ liveness: { state: 'stale' } });

    const staleRunId = 'run-unexpected-stale';
    await store.upsertPending({ runId: staleRunId, sessionId: 'session-unexpected-stale' });
    await store.acquireLease(staleRunId, 'worker-stale', 60_000);
    await store.releaseLease(staleRunId, 'worker-stale', undefined, 'unexpected_worker_exit');

    const reaped = await store.reapExpiredLiveness(new Date(Date.now() + 3_600_000), 0);
    expect(reaped.orphaned.map((run) => run.runId)).toContain(staleRunId);
    await expect(store.get(legacyRunId)).resolves.toMatchObject({ status: 'running' });
    await expect(store.acquireLease(legacyRunId, 'worker-current', 60_000)).resolves.toMatchObject({
      workerId: 'worker-current',
      liveness: { state: 'busy' },
    });
  });

  it('重启扫描修复 orphan COMMIT 后缺失的 terminal outbox，且并发修复只发布一次', async () => {
    const runId = 'run-orphan-outbox-restart'; const sessionId = 'session-orphan-outbox-restart';
    await store.upsertPending({ runId, sessionId });
    await store.acquireLease(runId, 'worker-crashed', 60_000);
    await store.releaseLease(runId, 'worker-crashed', undefined, 'unexpected_worker_exit');
    const first = await store.reapExpiredLiveness(new Date(Date.now() + 3_600_000), 0);
    expect(first.orphaned.map(run => run.runId)).toContain(runId);
    expect(readTerminalEventOutbox(await store.get(runId))).toBeNull();

    // Simulate process exit after the orphan transaction committed and before scheduler finalization.
    const repaired = await store.reapExpiredLiveness(new Date(Date.now() + 3_600_001), 0);
    const record = repaired.orphaned.find(run => run.runId === runId)!;
    const finalize = () => finalizeTerminalRun({
      runStore: store, eventStore, runId, status: 'orphaned', reason: 'lease_expired',
      expectedStatuses: ['orphaned'], stateOnlyRepair: true,
      events: [{ type: 'run_state_changed', runId, sessionId, status: 'orphaned', previousStatus: 'running', reason: 'lease_expired' }],
      ctx: { tenantId: record.tenantId! },
    });
    const results = await Promise.all([finalize(), finalize()]);
    expect(results.filter(result => result.won)).toHaveLength(1);
    expect(readTerminalEventOutbox(await store.get(runId))).toMatchObject({ state: 'delivered', terminalStatus: 'orphaned' });
    const events = await eventStore.list(record.tenantId!, sessionId);
    expect(events.filter(event => event.type === 'run_state_changed' && event.runId === runId)).toHaveLength(1);
    expect((await store.reapExpiredLiveness(new Date(Date.now() + 3_600_002), 0)).orphaned.map(run => run.runId)).not.toContain(runId);
  });

  it('N+1 交接后回滚到 N 时，旧版 version-null acquire 谓词仍能取得任务', async () => {
    const runId = 'run-rollback-to-n';
    await store.upsertPending({ runId, sessionId: 'session-rollback-to-n' });
    await store.acquireLease(runId, 'worker-n-plus-one', 60_000);
    await store.releaseLease(runId, 'worker-n-plus-one', undefined, 'server_drain_handoff', {
      handoff: true,
    });

    const listedByN = await pool.query(
      `
      SELECT run_id FROM ${prefix}_runs
      WHERE run_id = $1 AND (
        status = 'pending'
        OR (status = 'running' AND liveness_version IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp()))
      )
    `,
      [runId],
    );
    expect(listedByN.rowCount).toBe(1);

    const acquiredByN = await pool.query(
      `
      UPDATE ${prefix}_runs
      SET worker_id = 'worker-n', lease_expires_at = clock_timestamp() + interval '60 seconds',
          liveness_state = 'busy', liveness_version = COALESCE(liveness_version, 0) + 1
      WHERE run_id = $1 AND status = 'running' AND liveness_version IS NULL
        AND lease_expires_at IS NULL
      RETURNING run_id
    `,
      [runId],
    );
    expect(acquiredByN.rowCount).toBe(1);
  });
});
