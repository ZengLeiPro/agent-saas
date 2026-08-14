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
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_message_submissions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('同一 clientMessageId 并发提交只创建一个 run', async () => {
    const base = {
      sessionId: 'session-idempotent',
      userId: 'user-1',
      idempotencyKey: 'client-message-1',
      channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: 'session-idempotent', content: '只执行一次' } },
    };
    const [first, second] = await Promise.all([
      store.enqueueUserMessage({ ...base, runId: 'idempotent-run-a' }, 'queue'),
      store.enqueueUserMessage({ ...base, runId: 'idempotent-run-b' }, 'queue'),
    ]);

    expect(first.runId).toBe(second.runId);
    const rows = await pool.query(`SELECT run_id FROM ${prefix}_runs WHERE idempotency_key = $1`, ['client-message-1']);
    expect(rows.rows).toHaveLength(1);
  });

  it('同会话后入队 run 不能越过更早的 pending run', async () => {
    await store.enqueueUserMessage({
      runId: 'fifo-run-a', sessionId: 'session-fifo', userId: 'user-1', idempotencyKey: 'fifo-client-a', channel: 'web',
    }, 'queue');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.enqueueUserMessage({
      runId: 'fifo-run-b', sessionId: 'session-fifo', userId: 'user-1', idempotencyKey: 'fifo-client-b', channel: 'web',
    }, 'queue');

    await expect(store.acquireLease('fifo-run-b', 'worker-b', 60_000, new Date(), 4)).resolves.toBeNull();
    await expect(store.acquireLease('fifo-run-a', 'worker-a', 60_000, new Date(), 4)).resolves.toMatchObject({ runId: 'fifo-run-a' });
  });

  it('跨 worker 同会话同时抢占时只有一个 run 取得 lease', async () => {
    await store.enqueueUserMessage({
      runId: 'serial-run-a', sessionId: 'session-serial', userId: 'user-1', idempotencyKey: 'serial-client-a', channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: 'session-serial', content: 'A' } },
    }, 'queue');
    await store.enqueueUserMessage({
      runId: 'serial-run-b', sessionId: 'session-serial', userId: 'user-1', idempotencyKey: 'serial-client-b', channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: 'session-serial', content: 'B' } },
    }, 'queue');

    const acquired = await Promise.all([
      store.acquireLease('serial-run-a', 'worker-a', 60_000, new Date(), 4),
      store.acquireLease('serial-run-b', 'worker-b', 60_000, new Date(), 4),
    ]);
    expect(acquired.filter(Boolean)).toHaveLength(1);
    const running = await pool.query(`SELECT run_id FROM ${prefix}_runs WHERE session_id = $1 AND status = 'running'`, ['session-serial']);
    expect(running.rows).toHaveLength(1);
  });

  it.each(['waiting_user', 'waiting_approval'] as const)(
    '%s 释放会话后，显式发送回退为独立 run 且可取得 lease',
    async (waitingStatus) => {
      const sessionId = `session-${waitingStatus}`;
      const targetRunId = `target-${waitingStatus}`;
      const sourceRunId = `source-${waitingStatus}`;
      await store.upsertPending({
        runId: targetRunId,
        sessionId,
        userId: 'user-1',
        model: 'gpt-5.5',
        channel: 'web',
      });
      await store.markStatus(targetRunId, waitingStatus);

      const source = await store.enqueueUserMessage({
        runId: sourceRunId,
        sessionId,
        userId: 'user-1',
        idempotencyKey: `client-${waitingStatus}`,
        model: 'gpt-5.5',
        channel: 'web',
      }, 'steer');

      expect(source.metadata?.steeringTargetRunId).toBeUndefined();
      await expect(store.acquireLease(sourceRunId, `worker-${waitingStatus}`, 60_000))
        .resolves.toMatchObject({ runId: sourceRunId, status: 'running' });
      const steeringRows = await pool.query(
        `SELECT source_run_id FROM ${prefix}_steering_inputs WHERE source_run_id = $1`,
        [sourceRunId],
      );
      expect(steeringRows.rows).toHaveLength(0);
    },
  );

  it.each(['waiting_user', 'waiting_approval'] as const)(
    '%s 已释放会话时，普通 queue 不谎报排队并可直接取得 lease',
    async (waitingStatus) => {
      const sessionId = `session-queue-${waitingStatus}`;
      const targetRunId = `target-queue-${waitingStatus}`;
      const sourceRunId = `source-queue-${waitingStatus}`;
      await store.upsertPending({
        runId: targetRunId,
        sessionId,
        userId: 'user-1',
        channel: 'web',
      });
      await store.markStatus(targetRunId, waitingStatus);

      const source = await store.enqueueUserMessage({
        runId: sourceRunId,
        sessionId,
        userId: 'user-1',
        idempotencyKey: `client-queue-${waitingStatus}`,
        channel: 'web',
      }, 'queue');

      expect(source.metadata?.queuedBehindRunId).toBeUndefined();
      await expect(store.acquireLease(sourceRunId, `worker-queue-${waitingStatus}`, 60_000))
        .resolves.toMatchObject({ runId: sourceRunId, status: 'running' });
    },
  );

  it('停止只撤销 steer，普通 queue 保持 pending 并继续串行等待', async () => {
    const sessionId = 'session-stop-semantics';
    await store.upsertPending({
      runId: 'stop-target',
      sessionId,
      userId: 'user-1',
      model: 'gpt-5.5',
      channel: 'web',
    });
    await store.markStatus('stop-target', 'running');
    const queued = await store.enqueueUserMessage({
      runId: 'stop-queue',
      sessionId,
      userId: 'user-1',
      idempotencyKey: 'stop-queue-client',
      model: 'gpt-5.5',
      channel: 'web',
    }, 'queue');
    const steered = await store.enqueueUserMessage({
      runId: 'stop-steer',
      sessionId,
      userId: 'user-1',
      idempotencyKey: 'stop-steer-client',
      model: 'gpt-5.5',
      channel: 'web',
    }, 'steer');

    await store.cancelSteeringBeforeDispatchBySession(sessionId, 'web_abort');

    await expect(store.get(queued.runId)).resolves.toMatchObject({ status: 'pending' });
    await expect(store.get(steered.runId)).resolves.toMatchObject({ status: 'cancelled' });
  });

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
});
