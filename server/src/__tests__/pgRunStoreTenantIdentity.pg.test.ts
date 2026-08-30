import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { cleanupSteeringPgTest, describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';
const { Pool } = pg;

describePg('PgRunStore tenant identity PostgreSQL contract', () => {
  const prefix = `tenant_identity_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;
  let eventStore: PgEventStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000 });
    eventStore = new PgEventStore({ connectionString: testPgUrl!, tablePrefix: prefix });
    await eventStore.init();
    store = new PgRunStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (pool) await cleanupSteeringPgTest(pool, eventStore, prefix);
  }, 30_000);

  it('相同 session/clientMessageId 在不同 tenant 中保持独立 identity 与队列', async () => {
    const sessionId = 'shared-session-identity';
    const idempotencyKey = 'shared-client-message';
    await store.enqueueUserMessage({
      runId: 'tenant-a-message', tenantId: 'tenant-a', sessionId, userId: 'shared-user',
      idempotencyKey, channel: 'web', metadata: { wakeMessage: { content: 'tenant A' } },
    }, 'queue');
    await store.enqueueUserMessage({
      runId: 'tenant-b-message', tenantId: 'tenant-b', sessionId, userId: 'shared-user',
      idempotencyKey, channel: 'web', metadata: { wakeMessage: { content: 'tenant B' } },
    }, 'queue');

    await expect(store.listPendingUserMessagesBySession(sessionId, 'tenant-a')).resolves.toEqual([
      expect.objectContaining({ runId: 'tenant-a-message', tenantId: 'tenant-a' }),
    ]);
    await expect(store.listPendingUserMessagesBySession(sessionId, 'tenant-b')).resolves.toEqual([
      expect.objectContaining({ runId: 'tenant-b-message', tenantId: 'tenant-b' }),
    ]);
    const submissions = await pool.query(
      `SELECT tenant_id, run_id FROM ${prefix}_message_submissions WHERE client_message_id = $1 ORDER BY tenant_id`,
      [idempotencyKey],
    );
    expect(submissions.rows).toEqual([
      { tenant_id: 'tenant-a', run_id: 'tenant-a-message' },
      { tenant_id: 'tenant-b', run_id: 'tenant-b-message' },
    ]);
  });

});
