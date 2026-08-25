import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('Taskboard execution cancellation PostgreSQL races', () => {
  const prefix = `tb_cancel_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const identity: TaskboardIdentity = {
    tenantId: 'tenant-cancel', ownerUserId: 'owner-cancel', username: 'owner',
  };
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;
  let runStore: PgRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 8 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    runStore = new PgRunStore({ pool, tablePrefix: prefix });
    await Promise.all([store.init(), runStore.init()]);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`,
      [`${prefix}%`],
    );
    for (const { tablename } of tables.rows) {
      await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
    }
    await pool.end();
  }, 30_000);

  it('holds the execution fence behind durable run creation and rejects pending-cancellation claims', async () => {
    const suffix = randomUUID();
    const board = await store.createBoard(identity, { name: `取消门禁-${suffix}` });
    const task = await store.createTask(identity, board.id, { title: '取消与派发竞态', status: 'todo' });
    const executionId = `execution-${suffix}`;
    const runId = `run-${suffix}`;
    const sessionId = `session-${suffix}`;
    await store.claimExecution(identity, task.id, {
      expectedVersion: task.version,
      executionId,
      runId,
      sessionId,
      executionOwnerUserId: identity.ownerUserId,
      protocolVersion: 1,
      dispatch: {
        version: 1,
        session: {
          sessionId, userId: identity.ownerUserId, username: identity.username,
          tenantId: identity.tenantId, channel: 'web', cwd: '/tmp/taskboard-cancel-test',
          transcriptPath: `/tmp/taskboard-cancel-test/${sessionId}.jsonl`, status: 'running',
          createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
        },
        run: {
          runId, sessionId, userId: identity.ownerUserId, tenantId: identity.tenantId,
          channel: 'web', idempotencyKey: `taskboard-execution:${executionId}`,
          metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
        },
      },
    });
    await expect(store.claimExecutionDispatch(runId, 'lease-gate')).resolves.toMatchObject({ runId });

    let releaseGate!: () => void;
    const holdGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let gateEntered = false;
    const gated = store.runExecutionDispatchGate(runId, 'lease-gate', async () => {
      gateEntered = true;
      await holdGate;
      await runStore.createPending({
        runId, sessionId, tenantId: identity.tenantId,
        metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
      });
    });
    await expect.poll(() => gateEntered).toBe(true);
    let fenceFinished = false;
    const fence = pool.query(
      `UPDATE ${store.executionsTable} SET status='cancelled',finished_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('queued','running','waiting_user','waiting_approval')`,
      [executionId],
    ).then(() => { fenceFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fenceFinished).toBe(false);
    releaseGate();
    await expect(gated).resolves.toBe(true);
    await fence;
    await expect(runStore.get(runId)).resolves.toMatchObject({ runId });

    await pool.query(`UPDATE ${store.executionsTable} SET status='queued',finished_at=NULL WHERE id=$1`, [executionId]);
    await pool.query(
      `INSERT INTO ${store.cancellationOutboxTable}(id,execution_id,run_id,task_id,reason,fence_epoch)
       VALUES($1,$2,$3,$4,'superseded',1)`,
      [randomUUID(), executionId, runId, task.id],
    );
    await pool.query(
      `UPDATE ${store.executionOutboxTable}
       SET status='pending',lease_id=NULL,lease_expires_at=NULL,next_attempt_at=now() WHERE run_id=$1`,
      [runId],
    );
    await expect(store.claimExecutionDispatch(runId, 'lease-after-cancel')).resolves.toBeNull();
  });
});
