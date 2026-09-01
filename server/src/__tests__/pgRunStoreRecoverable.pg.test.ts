import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import {
  cleanupSteeringPgTest,
  describePg,
  testPgUrl,
} from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

describePg('PgRunStore recoverable PostgreSQL contract', () => {
  const prefix = `recoverable_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;
  let eventStore: PgEventStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000 });
    eventStore = new PgEventStore({ connectionString: testPgUrl!, tablePrefix: prefix });
    await eventStore.init();
    store = new PgRunStore({
      pool,
      tablePrefix: prefix,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (pool) await cleanupSteeringPgTest(pool, eventStore, prefix);
  }, 30_000);

  it('保留普通 run 和 background parent，永久排除 parent-owned child', async () => {
    const ordinaryRunId = 'recoverable-ordinary-run';
    const parentRunId = 'recoverable-background-parent';
    const childRunId = 'recoverable-subagent-child';
    await store.createPending({
      runId: ordinaryRunId,
      sessionId: 'session-recoverable-ordinary',
      userId: 'user-1',
    });
    await store.createPending({
      runId: parentRunId,
      sessionId: 'session-recoverable-parent',
      userId: 'user-1',
      metadata: { backgroundTask: true, backgroundTaskReady: true },
    });
    await store.createPending({
      runId: childRunId,
      sessionId: 'session-recoverable-child',
      userId: 'user-1',
      metadata: { subagent: true, parentRunId, parentSessionId: 'session-recoverable-parent' },
    });

    const recoverable = await store.listRecoverable();
    expect(recoverable).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: ordinaryRunId, status: 'pending' }),
      expect.objectContaining({
        runId: parentRunId,
        status: 'pending',
        metadata: expect.objectContaining({ backgroundTaskReady: true }),
      }),
    ]));
    expect(recoverable).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: childRunId })]),
    );
    await expect(store.get(childRunId)).resolves.toMatchObject({ status: 'pending' });
  });
});
