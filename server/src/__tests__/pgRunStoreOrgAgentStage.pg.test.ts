import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('组织 Agent staged run PostgreSQL CAS', () => {
  const prefix = `orgstage_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgRunStore({ pool, tablePrefix: prefix });
    await store.init();
  });

  afterAll(async () => {
    if (!pool) return;
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
       AND LEFT(tablename,LENGTH($1))=$1`,
      [prefix],
    );
    for (const row of tables.rows)
      await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    await pool.end();
  });

  it('activates only pending v2 organization runs once and never regresses a running run', async () => {
    await store.upsertPending({
      runId: 'org-stage-1',
      sessionId: 'org-stage-session-1',
      tenantId: 'tenant-a',
      channel: 'background_task',
      metadata: {
        backgroundTask: true,
        backgroundTaskVersion: 2,
        backgroundTaskReady: false,
        orgAgentChannel: { agentId: 'agent-a' },
      },
    });
    await expect(
      store.activateStagedOrgAgentBackgroundTask('org-stage-1', 'activate', {
        activationEvidence: 'first',
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      metadata: { backgroundTaskReady: true, activationEvidence: 'first' },
    });
    await expect(
      store.activateStagedOrgAgentBackgroundTask('org-stage-1', 'duplicate'),
    ).resolves.toBeNull();
    await store.markStatus('org-stage-1', 'running');
    await pool.query(`UPDATE ${prefix}_runs SET metadata=metadata || '{"backgroundTaskReady":false}'::jsonb
      WHERE run_id='org-stage-1'`);
    await expect(
      store.activateStagedOrgAgentBackgroundTask('org-stage-1', 'must-not-regress'),
    ).resolves.toBeNull();
    await expect(store.get('org-stage-1')).resolves.toMatchObject({ status: 'running' });
  });
});
