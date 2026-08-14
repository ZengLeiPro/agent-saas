import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('PgRunStore steering PostgreSQL contract', () => {
  const prefix = `steering_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgRunStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_inputs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_sessions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('enqueue → reserve → apply 由真实 PostgreSQL 解析并原子结算', async () => {
    await store.upsertPending({
      runId: 'target-run',
      sessionId: 'session-1',
      userId: 'user-1',
      model: 'gpt-5.5',
      channel: 'web',
    });
    await store.markStatus('target-run', 'running');

    const source = await store.enqueueSteeringAware({
      runId: 'source-run',
      sessionId: 'session-1',
      userId: 'user-1',
      model: 'gpt-5.5',
      channel: 'web',
      metadata: {
        clientMsgId: 'client-1',
        wakeMessage: { channel: 'web', chatId: 'session-1', content: '追加要求' },
      },
    });
    expect(source.metadata).toMatchObject({
      steeringTargetRunId: 'target-run',
      steeringState: 'pending',
    });

    await expect(store.reserveSteeringInputs('target-run', ['source-run']))
      .resolves.toEqual(['source-run']);
    const reserved = await store.listPendingSteeringInputs('target-run');
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({ sourceRunId: 'source-run', state: 'reserved' });
    expect(reserved[0]?.reservedAt).toBeTruthy();

    await expect(store.markSteeringInputsApplied('target-run', ['source-run']))
      .resolves.toEqual(['source-run']);

    const row = await pool.query<{
      state: string;
      reserved_at: Date | null;
      applied_at: Date | null;
    }>(`SELECT state, reserved_at, applied_at FROM ${prefix}_steering_inputs WHERE source_run_id = $1`, ['source-run']);
    expect(row.rows[0]).toMatchObject({ state: 'applied' });
    expect(row.rows[0]?.reserved_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.applied_at).toBeInstanceOf(Date);
    await expect(store.get('source-run')).resolves.toMatchObject({
      status: 'completed',
      statusReason: 'steered_into_run',
      metadata: { steeringState: 'applied', steeringAppliedToRunId: 'target-run' },
    });
  });

  it('停止目标时仅释放 pending Taskboard source，reserved source 不回退为独立 run', async () => {
    await store.upsertPending({
      runId: 'target-stop-run',
      sessionId: 'session-stop',
      userId: 'user-1',
      model: 'gpt-5.5',
      channel: 'web',
    });
    await store.markStatus('target-stop-run', 'running');

    for (const sourceRunId of ['source-pending', 'source-reserved']) {
      await store.enqueueSteeringAware({
        runId: sourceRunId,
        sessionId: 'session-stop',
        userId: 'user-1',
        model: 'gpt-5.5',
        channel: 'web',
        metadata: {
          taskboardContinuation: true,
          wakeMessage: { channel: 'web', chatId: 'session-stop', content: sourceRunId },
        },
      });
    }
    await expect(store.reserveSteeringInputs('target-stop-run', ['source-reserved']))
      .resolves.toEqual(['source-reserved']);

    await expect(store.cancelSteeringBeforeDispatchBySession(
      'session-stop',
      'target cancelled',
      'target-stop-run',
    )).resolves.toEqual([]);

    const inputs = await pool.query<{ source_run_id: string; state: string }>(
      `SELECT source_run_id, state FROM ${prefix}_steering_inputs
        WHERE source_run_id IN ('source-pending', 'source-reserved') ORDER BY source_run_id`,
    );
    expect(inputs.rows).toEqual([
      { source_run_id: 'source-pending', state: 'released' },
      { source_run_id: 'source-reserved', state: 'cancelled' },
    ]);
    await expect(store.get('source-pending')).resolves.toMatchObject({
      status: 'pending',
      metadata: { steeringState: 'released' },
    });
    await expect(store.get('source-reserved')).resolves.toMatchObject({
      status: 'cancelled',
      metadata: { steeringState: 'cancelled' },
    });
  });
});
