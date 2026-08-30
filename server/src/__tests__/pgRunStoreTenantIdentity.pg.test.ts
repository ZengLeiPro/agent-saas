import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { PgSessionLock } from '../runtime/pgSessionLock.js';
import { PgRunStore } from '../runtime/runStore.js';
import { describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;
const makePrefix = (label: string) => `${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

describePg('PgRunStore tenant/session identity and legacy migration', () => {
  let pool: InstanceType<typeof Pool>;
  const prefixes: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
  });

  afterAll(async () => {
    for (const prefix of prefixes) {
      const tables = (await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE $1`,
        [`${prefix}_%`],
      )).rows.map((row) => row.tablename);
      for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await pool.end();
  }, 30_000);

  it('同名 session 在双租户可并行 lease，Responses find/update/clear 严格隔离', async () => {
    const prefix = makePrefix('tenant_identity');
    prefixes.push(prefix);
    const store = new PgRunStore({ pool, tablePrefix: prefix });
    await store.init();
    await store.createPending({ runId: 'run-a', tenantId: 'tenant-a', sessionId: 'shared-session', channel: 'web' });
    await store.createPending({ runId: 'run-b', tenantId: 'tenant-b', sessionId: 'shared-session', channel: 'web' });
    await expect(store.getActiveBySession('tenant-a', 'shared-session')).resolves.toMatchObject({ runId: 'run-a', tenantId: 'tenant-a' });
    await expect(store.getActiveBySession('tenant-b', 'shared-session')).resolves.toMatchObject({ runId: 'run-b', tenantId: 'tenant-b' });

    const leases = await Promise.all([
      store.acquireLease('run-a', 'worker-a', 60_000, new Date(), 4, undefined, { tenantId: 'tenant-a', sessionId: 'shared-session' }),
      store.acquireLease('run-b', 'worker-b', 60_000, new Date(), 4, undefined, { tenantId: 'tenant-b', sessionId: 'shared-session' }),
    ]);
    expect(leases).toEqual([
      expect.objectContaining({ runId: 'run-a', tenantId: 'tenant-a' }),
      expect.objectContaining({ runId: 'run-b', tenantId: 'tenant-b' }),
    ]);
    await expect(store.acquireLease('run-a', 'wrong-worker', 60_000, new Date(), 4, undefined, {
      tenantId: 'tenant-b', sessionId: 'shared-session',
    })).resolves.toBeNull();

    await store.updateResponseSessionState('run-a', 'tenant-a', 'shared-session', {
      lastResponseId: 'resp-a', lastResponseModel: 'model', lastResponseProfileDigest: 'profile',
    });
    await store.updateResponseSessionState('run-b', 'tenant-b', 'shared-session', {
      lastResponseId: 'resp-b', lastResponseModel: 'model', lastResponseProfileDigest: 'profile',
    });
    await expect(store.updateResponseSessionState('run-a', 'tenant-b', 'shared-session', { lastResponseId: 'leak' }))
      .resolves.toBeNull();
    await expect(store.findLatestResponseSessionStateBySession('tenant-a', 'shared-session'))
      .resolves.toMatchObject({ runId: 'run-a', lastResponseId: 'resp-a' });
    await expect(store.findLatestResponseSessionStateBySession('tenant-b', 'shared-session'))
      .resolves.toMatchObject({ runId: 'run-b', lastResponseId: 'resp-b' });
    await expect(store.clearResponseSessionStateBySession('tenant-a', 'shared-session')).resolves.toBe(1);
    await expect(store.findLatestResponseSessionStateBySession('tenant-a', 'shared-session')).resolves.toBeNull();
    await expect(store.findLatestResponseSessionStateBySession('tenant-b', 'shared-session'))
      .resolves.toMatchObject({ lastResponseId: 'resp-b' });
  }, 30_000);

  it('旧 session lease 表可兼容迁移，跨租户并行且同租户并发只有一个 owner', async () => {
    const prefix = makePrefix('tenant_lock');
    prefixes.push(prefix);
    await pool.query(`
      CREATE TABLE ${prefix}_session_leases (
        session_id TEXT PRIMARY KEY,
        owner_token TEXT NOT NULL,
        lease_expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO ${prefix}_session_leases VALUES ('legacy-session', 'old-owner', now() + interval '1 minute', now());
    `);
    const lock = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'lease' });
    await lock.init();
    const migrated = await pool.query(`SELECT tenant_id, session_id FROM ${prefix}_session_leases`);
    expect(migrated.rows).toEqual([{ tenant_id: LEGACY_TENANT_ID, session_id: 'legacy-session' }]);

    const [tenantA, tenantB] = await Promise.all([
      lock.tryAcquire('tenant-a', 'shared-session'),
      lock.tryAcquire('tenant-b', 'shared-session'),
    ]);
    expect(tenantA).not.toBeNull();
    expect(tenantB).not.toBeNull();
    const contenders = await Promise.all(Array.from({ length: 8 }, () =>
      lock.tryAcquire('tenant-c', 'contended-session')));
    expect(contenders.filter(Boolean)).toHaveLength(1);
    await Promise.allSettled([tenantA?.release(), tenantB?.release(), ...contenders.map((entry) => entry?.release())]);
    await lock.close();
  }, 30_000);

  it('dual→lease 滚动重叠期间，同租户同 session 不双活且跨租户可并行', async () => {
    const prefix = makePrefix('session_lock_rollout');
    prefixes.push(prefix);
    const dual = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'dual' });
    await dual.init();
    const dualHandle = await dual.tryAcquire('tenant-a', 'shared-session');
    expect(dualHandle).not.toBeNull();

    const lease = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'lease' });
    await lease.init();
    await expect(lease.tryAcquire('tenant-a', 'shared-session')).resolves.toBeNull();
    const otherTenant = await lease.tryAcquire('tenant-b', 'shared-session');
    expect(otherTenant).not.toBeNull();

    await dualHandle?.release();
    const sameTenantAfterRelease = await lease.tryAcquire('tenant-a', 'shared-session');
    expect(sameTenantAfterRelease).not.toBeNull();
    await Promise.allSettled([otherTenant?.release(), sameTenantAfterRelease?.release()]);
    await Promise.all([dual.close(), lease.close()]);
  }, 30_000);

  it('旧辅助表并发 init：可证明行回填，orphan/ambiguous 原子进 quarantine 且不阻断 NOT NULL', async () => {
    const prefix = makePrefix('legacy_identity');
    prefixes.push(prefix);
    await pool.query(`
      CREATE TABLE ${prefix}_runs (
        run_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT,
        submitter_scope TEXT, status TEXT NOT NULL, status_reason TEXT, model TEXT, channel TEXT,
        requested_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ, failed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, worker_id TEXT,
        lease_expires_at TIMESTAMPTZ, idempotency_key TEXT, execution_target TEXT, workspace_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'
      );
      CREATE TABLE ${prefix}_message_submissions (
        user_scope TEXT NOT NULL, client_message_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL, delivery_mode TEXT NOT NULL, accepted_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (user_scope, client_message_id)
      );
      CREATE TABLE ${prefix}_steering_inputs (
        input_id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL UNIQUE, target_run_id TEXT NOT NULL,
        session_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', accepted_at TIMESTAMPTZ NOT NULL,
        applied_at TIMESTAMPTZ
      );
      CREATE TABLE ${prefix}_steering_sessions (session_id TEXT PRIMARY KEY, stopped_at TIMESTAMPTZ);
    `);
    await pool.query(`
      INSERT INTO ${prefix}_runs (run_id, tenant_id, session_id, status, requested_at, updated_at)
      VALUES ('owned-a', 'tenant-a', 'ambiguous-session', 'completed', now(), now()),
             ('owned-b', 'tenant-b', 'ambiguous-session', 'completed', now(), now()),
             ('owned-d', 'tenant-a', 'ambiguous-session', 'completed', now(), now()),
             ('owned-e', 'tenant-a', 'ambiguous-session', 'completed', now(), now()),
             ('owned-c', 'tenant-c', 'unique-session', 'completed', now(), now());
      INSERT INTO ${prefix}_message_submissions
        (user_scope, client_message_id, run_id, session_id, delivery_mode, accepted_at)
      VALUES ('user', 'owned', 'owned-a', 'ambiguous-session', 'queue', now()),
             ('user', 'orphan', 'missing-run', 'orphan-session', 'queue', now());
      INSERT INTO ${prefix}_steering_inputs
        (input_id, source_run_id, target_run_id, session_id, accepted_at)
      VALUES ('owned-input', 'owned-a', 'owned-d', 'ambiguous-session', now()),
             ('mismatch-input', 'owned-e', 'owned-b', 'ambiguous-session', now()),
             ('orphan-input', 'missing-source', 'owned-b', 'ambiguous-session', now());
      INSERT INTO ${prefix}_steering_sessions (session_id)
      VALUES ('ambiguous-session'), ('orphan-session'), ('unique-session');
    `);

    const stores = [new PgRunStore({ pool, tablePrefix: prefix }), new PgRunStore({ pool, tablePrefix: prefix })];
    await Promise.all(stores.map((store) => store.init()));
    await stores[0]!.init(); // full migration is idempotent after validation

    const submissions = await pool.query(`SELECT run_id, tenant_id FROM ${prefix}_message_submissions ORDER BY run_id`);
    expect(submissions.rows).toEqual([{ run_id: 'owned-a', tenant_id: 'tenant-a' }]);
    const inputs = await pool.query(`SELECT source_run_id, tenant_id FROM ${prefix}_steering_inputs ORDER BY source_run_id`);
    expect(inputs.rows).toEqual([{ source_run_id: 'owned-a', tenant_id: 'tenant-a' }]);
    const sessions = await pool.query(`SELECT session_id, tenant_id FROM ${prefix}_steering_sessions`);
    expect(sessions.rows).toEqual([{ session_id: 'unique-session', tenant_id: 'tenant-c' }]);

    const submissionQuarantine = await pool.query(`SELECT reason, payload->>'run_id' AS id FROM ${prefix}_message_submissions_tenant_quarantine`);
    expect(submissionQuarantine.rows).toEqual([{ reason: 'orphan_run', id: 'missing-run' }]);
    const inputQuarantine = await pool.query(`SELECT reason, payload->>'source_run_id' AS id FROM ${prefix}_steering_inputs_tenant_quarantine ORDER BY reason`);
    expect(inputQuarantine.rows).toEqual([
      { reason: 'orphan_source_run', id: 'missing-source' },
      { reason: 'tenant_session_mismatch', id: 'owned-e' },
    ]);
    const sessionQuarantine = await pool.query(`SELECT reason, payload->>'session_id' AS id FROM ${prefix}_steering_sessions_tenant_quarantine ORDER BY reason`);
    expect(sessionQuarantine.rows).toEqual([
      { reason: 'ambiguous_session', id: 'ambiguous-session' },
      { reason: 'orphan_session', id: 'orphan-session' },
    ]);
    const nullable = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.columns
      WHERE table_name IN ($1, $2, $3) AND column_name = 'tenant_id' AND is_nullable <> 'NO'
    `, [`${prefix}_message_submissions`, `${prefix}_steering_inputs`, `${prefix}_steering_sessions`]);
    expect(nullable.rows[0]?.count).toBe('0');
  }, 30_000);
});
