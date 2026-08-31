import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { RUN_STORE_TENANT_SCHEMA_VERSION } from '../runtime/runStoreSchema.js';
import { describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

describePg('PgRunStore tenant rolling migration', () => {
  const prefix = `rolling_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgRunStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    for (const suffix of [
      'steering_sessions_tenant_quarantine', 'steering_inputs_tenant_quarantine',
      'message_submissions_tenant_quarantine', 'steering_sessions', 'steering_inputs',
      'message_submissions', 'runs',
    ]) await pool.query(`DROP TABLE IF EXISTS ${prefix}_${suffix}`);
    for (const fn of ['message_submissions_tenant_expand_fn', 'steering_inputs_tenant_expand_fn',
      'steering_sessions_tenant_expand_fn', 'runs_tenant_aux_catchup_fn']) {
      await pool.query(`DROP FUNCTION IF EXISTS ${prefix}_${fn}()`);
    }
    await pool.end();
  }, 30_000);

  it('expand keeps legacy arbiters while old SQL and tenant-aware dual writes coexist', async () => {
    await store.upsertPending({ runId: 'legacy-source', sessionId: 'legacy-session', tenantId: 'tenant-legacy' });
    await store.upsertPending({ runId: 'legacy-target', sessionId: 'legacy-session', tenantId: 'tenant-legacy' });

    await expect(pool.query(`
      INSERT INTO ${prefix}_message_submissions
        (user_scope, client_message_id, run_id, session_id, delivery_mode, accepted_at)
      VALUES ('legacy-user','legacy-message','legacy-source','legacy-session','queue',now())
      ON CONFLICT (user_scope, client_message_id) DO NOTHING
    `)).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(`
      INSERT INTO ${prefix}_steering_inputs
        (input_id, source_run_id, target_run_id, session_id, state, accepted_at)
      VALUES ('legacy-input','legacy-source','legacy-target','legacy-session','pending',now())
      ON CONFLICT (source_run_id) DO NOTHING
    `)).resolves.toMatchObject({ rowCount: 1 });

    const common = {
      sessionId: 'shared-session', userId: 'shared-user', submitterUserId: 'shared-user',
      idempotencyKey: 'shared-message', channel: 'web',
    };
    const [a, b] = await Promise.all([
      store.enqueueUserMessage({ ...common, tenantId: 'tenant-a', runId: 'tenant-a-run' }, 'queue'),
      store.enqueueUserMessage({ ...common, tenantId: 'tenant-b', runId: 'tenant-b-run' }, 'queue'),
    ]);
    expect([a.runId, b.runId].sort()).toEqual(['tenant-a-run', 'tenant-b-run']);
    await expect(store.findByIdempotencyKey('tenant-a', 'shared-user', 'shared-message'))
      .resolves.toMatchObject({ runId: 'tenant-a-run' });
    await expect(store.findByIdempotencyKey('tenant-b', 'shared-user', 'shared-message'))
      .resolves.toMatchObject({ runId: 'tenant-b-run' });
    const physicalSubmissions = await pool.query<{
      tenant_id: string; user_scope: string; client_message_id: string;
      tenant_user_scope: string; tenant_client_message_id: string;
    }>(`SELECT tenant_id,user_scope,client_message_id,tenant_user_scope,tenant_client_message_id
        FROM ${prefix}_message_submissions WHERE run_id IN ('tenant-a-run','tenant-b-run') ORDER BY tenant_id`);
    expect(physicalSubmissions.rows.map(({ tenant_id, tenant_user_scope, tenant_client_message_id }) =>
      [tenant_id, tenant_user_scope, tenant_client_message_id])).toEqual([
      ['tenant-a', 'shared-user', 'shared-message'], ['tenant-b', 'shared-user', 'shared-message'],
    ]);
    expect(new Set(physicalSubmissions.rows.map(({ user_scope }) => user_scope)).size).toBe(2);
    expect(physicalSubmissions.rows.every(({ user_scope }) => user_scope !== 'shared-user')).toBe(true);

    await store.cancelSteeringBeforeDispatchBySession('shared-session', 'rolling-test', undefined, 'tenant-a');
    await store.cancelSteeringBeforeDispatchBySession('shared-session', 'rolling-test', undefined, 'tenant-b');
    const physicalSessions = await pool.query<{ tenant_id: string; session_id: string; tenant_session_id: string }>(`
      SELECT tenant_id,session_id,tenant_session_id FROM ${prefix}_steering_sessions ORDER BY tenant_id
    `);
    expect(physicalSessions.rows.map(({ tenant_id, tenant_session_id }) => [tenant_id, tenant_session_id]))
      .toEqual([['tenant-a', 'shared-session'], ['tenant-b', 'shared-session']]);
    expect(new Set(physicalSessions.rows.map(({ session_id }) => session_id)).size).toBe(2);
    expect(physicalSessions.rows.every(({ session_id }) => session_id !== 'shared-session')).toBe(true);

    const constraints = await pool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
      WHERE conrelid='${prefix}_message_submissions'::regclass AND contype='p'
    `);
    expect(constraints.rows[0]?.definition).toContain('(user_scope, client_message_id)');
    const nullable = await pool.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name='${prefix}_message_submissions' AND column_name='tenant_id'
    `);
    expect(nullable.rows[0]?.is_nullable).toBe('YES');
  });

  it('contract is explicit, gated, and tightens only after final backfill/quarantine', async () => {
    await expect(store.contractTenantSchema({
      expectedExpandVersion: 0,
      oldWritersDrained: true,
    } as never)).rejects.toThrow('contract gate rejected');

    const gate = {
      expectedExpandVersion: RUN_STORE_TENANT_SCHEMA_VERSION,
      oldWritersDrained: true,
    } as const;
    await store.contractTenantSchema(gate);
    await expect(store.contractTenantSchema(gate)).resolves.toBeUndefined();

    const columns = await pool.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_name='${prefix}_message_submissions'
        AND column_name IN ('tenant_id','tenant_user_scope','tenant_client_message_id')
      ORDER BY column_name
    `);
    expect(columns.rows.every((row) => row.is_nullable === 'NO')).toBe(true);
    const constraint = await pool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
      WHERE conrelid='${prefix}_message_submissions'::regclass AND contype='p'
    `);
    expect(constraint.rows[0]?.definition)
      .toContain('(tenant_id, tenant_user_scope, tenant_client_message_id)');
    await expect(pool.query(`SELECT tenant_id FROM ${prefix}_message_submissions WHERE run_id='legacy-source'`))
      .resolves.toMatchObject({ rows: [{ tenant_id: 'tenant-legacy' }] });
  });
});
