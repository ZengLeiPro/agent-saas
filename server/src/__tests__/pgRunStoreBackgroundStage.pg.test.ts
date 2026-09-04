import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

describePg('PgRunStore v2 background task stage', () => {
  const prefix = `background_stage_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000 });
    store = new PgRunStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
    await pool.end();
  }, 30_000);

  it('激活前可被超时恢复扫描但不可取得 lease，ready 后才可领取', async () => {
    const runId = 'staged-background-task-run';
    await store.createPending({
      runId,
      sessionId: 'session-staged-background-task',
      userId: 'user-1',
      idempotencyKey: 'staged-background-task-client',
      channel: 'web',
      metadata: { backgroundTask: true, backgroundTaskVersion: 2, backgroundTaskReady: false },
    });

    await expect(store.listRecoverable()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ runId })]),
    );
    await expect(store.acquireLease(runId, 'worker-background-staged', 60_000)).resolves.toBeNull();

    await store.markStatus(runId, 'pending', undefined, { backgroundTaskReady: true });
    await expect(store.listRecoverable()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ runId, status: 'pending' })]),
    );
    await expect(
      store.acquireLease(runId, 'worker-background-ready', 60_000),
    ).resolves.toMatchObject({
      runId,
      status: 'running',
    });
  });
});
