import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { recoverRunningToolInvocations } from '../runtime/toolInvocationRecovery.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
if (!testPgUrl) {
  console.warn('[pgRunStoreToolCancellationRecovery.pg] SKIPPED: TEST_DATABASE_URL is not configured');
}

describePg('PgRunStore tool cancellation recovery PostgreSQL contract', () => {
  const prefix = `tool_cancel_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
    try {
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_tool_invocations`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_inputs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_sessions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_message_submissions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_events`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_event_cursors`);
    } finally {
      await eventStore?.close();
      await pool.end();
    }
  }, 30_000);

  it('恢复快照后 invocation 先完成、run 后取消时不误建 cancel outbox', async () => {
    const sessionId = 'session-recovery-snapshot-race';
    const runId = 'run-recovery-snapshot-race';
    const invocationId = 'invocation-recovery-snapshot-race';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-recovery-snapshot-race',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    const originalListRunning = toolInvocationStore.listRunning.bind(toolInvocationStore);
    let snapshotRead!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotReadPromise = new Promise<void>((resolve) => { snapshotRead = resolve; });
    const releaseSnapshotPromise = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    toolInvocationStore.listRunning = async (requestedSessionId?: string) => {
      const records = await originalListRunning(requestedSessionId);
      snapshotRead();
      await releaseSnapshotPromise;
      return records;
    };

    const recovery = recoverRunningToolInvocations({ toolInvocationStore, eventStore, runStore: store });
    try {
      await snapshotReadPromise;
      await toolInvocationStore.complete(invocationId, 'completed');
      await store.markStatus(runId, 'cancelled', 'web_abort');
      releaseSnapshot();
      await expect(recovery).resolves.toMatchObject({ scanned: 1, recovered: 0 });
    } finally {
      releaseSnapshot();
      toolInvocationStore.listRunning = originalListRunning;
    }

    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({ status: 'completed' });
    expect((await toolInvocationStore.get(invocationId))?.cancelRequestedAt).toBeUndefined();
  });

  it('恢复器为 cancelled run 下已终态的 invocation 补登记一次 cancel outbox', async () => {
    const sessionId = 'session-terminal-cancel-repair';
    const runId = 'run-terminal-cancel-repair';
    const invocationId = 'invocation-terminal-cancel-repair';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-terminal-cancel-repair',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });
    // 使用 PostgreSQL 微秒时间模拟旧版本/崩溃留下的终态半状态；RunStore.get 会把
    // cancelledAt 归一化到毫秒，恢复 CAS 必须直接使用数据库权威时间而非 JS 等值比较。
    await pool.query(`
      UPDATE ${prefix}_runs
      SET status = 'cancelled', status_reason = 'web_abort',
          cancelled_at = TIMESTAMPTZ '2026-08-15 00:00:00.123456+00',
          updated_at = TIMESTAMPTZ '2026-08-15 00:00:00.123456+00'
      WHERE run_id = $1
    `, [runId]);
    await pool.query(`
      UPDATE ${prefix}_tool_invocations
      SET status = 'failed',
          completed_at = TIMESTAMPTZ '2026-08-15 00:00:00.123457+00',
          updated_at = TIMESTAMPTZ '2026-08-15 00:00:00.123457+00',
          error = 'worker crashed'
      WHERE invocation_id = $1
    `, [invocationId]);

    await expect(recoverRunningToolInvocations({
      toolInvocationStore,
      eventStore,
      runStore: store,
    })).resolves.toMatchObject({ recovered: 0 });

    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({
      status: 'failed',
      cancelRequestedAt: expect.any(String),
      cancelReason: 'recovered_after_cancelled_run',
    });
    await expect(toolInvocationStore.requestCancelOnce(invocationId, 'duplicate')).resolves.toMatchObject({ created: false });
  });

  it('PostgreSQL 工具取消只选出一个事件发布者和一个外部投递 claimant', async () => {
    await store.upsertPending({
      runId: 'run-cancel-cas',
      sessionId: 'session-cancel-cas',
      userId: 'user-1',
      channel: 'web',
    });
    await store.markStatus('run-cancel-cas', 'running');
    await toolInvocationStore.start({
      invocationId: 'invocation-cancel-cas',
      runId: 'run-cancel-cas',
      sessionId: 'session-cancel-cas',
      toolCallId: 'call-cancel-cas',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    const requests = await Promise.all([
      toolInvocationStore.requestCancelOnce('invocation-cancel-cas', 'web_abort'),
      toolInvocationStore.requestCancelOnce('invocation-cancel-cas', 'web_abort'),
    ]);
    expect(requests.map((item) => item?.created).sort()).toEqual([false, true]);

    const claimNow = new Date('2026-08-15T00:00:00.000Z');
    const claims = await Promise.all([
      toolInvocationStore.claimCancelDelivery('invocation-cancel-cas', 'claim-a', 30_000, claimNow),
      toolInvocationStore.claimCancelDelivery('invocation-cancel-cas', 'claim-b', 30_000, claimNow),
    ]);
    const winner = claims.find((claim) => claim)?.metadata.cancelDeliveryClaimId;
    const loser = winner === 'claim-a' ? 'claim-b' : 'claim-a';
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(winner).toMatch(/^claim-[ab]$/);
    await expect(toolInvocationStore.markCancelDelivered(
      'invocation-cancel-cas', { cancelDelivery: 'stale' }, loser,
    )).resolves.toBeNull();
    await expect(toolInvocationStore.markCancelDelivered(
      'invocation-cancel-cas', { cancelDelivery: 'delivered' }, String(winner),
    )).resolves.toMatchObject({ cancelDeliveredAt: expect.any(String) });
  });
});
