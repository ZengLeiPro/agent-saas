import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { RUN_STORE_TENANT_SCHEMA_VERSION } from '../runtime/runStoreSchema.js';
import { RunCreateConflictError } from '../runtime/runStoreTypes.js';
import { describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

describePg('PgRunStore provable two-phase tenant migration', () => {
  const prefix = `rolling_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    store = new PgRunStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    for (const suffix of [
      'steering_sessions_tenant_quarantine', 'steering_inputs_tenant_quarantine',
      'message_submissions_tenant_quarantine', 'steering_sessions', 'steering_inputs',
      'message_submissions', 'runs_schema_migrations', 'runs',
    ]) await pool.query(`DROP TABLE IF EXISTS ${prefix}_${suffix}`);
    for (const fn of ['message_submissions_tenant_expand_fn', 'steering_inputs_tenant_expand_fn',
      'steering_sessions_tenant_expand_fn', 'runs_tenant_aux_catchup_fn']) {
      await pool.query(`DROP FUNCTION IF EXISTS ${prefix}_${fn}()`);
    }
    await pool.end();
  }, 30_000);

  const oldEnqueue = async (runId: string, sessionId: string, tenantId: string, user: string, key: string) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ run_id: string }>(`
        INSERT INTO ${prefix}_message_submissions
          (user_scope,client_message_id,run_id,session_id,delivery_mode,accepted_at)
        VALUES ($1,$2,$3,$4,'queue',now())
        ON CONFLICT (user_scope,client_message_id) DO NOTHING RETURNING run_id
      `, [user, key, runId, sessionId]);
      if (!inserted.rows[0]) {
        const authority = await client.query<{ run_id: string }>(`
          SELECT run_id FROM ${prefix}_message_submissions
          WHERE user_scope=$1 AND client_message_id=$2
        `, [user, key]);
        await client.query('COMMIT');
        return authority.rows[0]?.run_id;
      }
      await client.query(`
        INSERT INTO ${prefix}_runs
          (run_id,session_id,user_id,tenant_id,status,channel,requested_at,updated_at,
           idempotency_key,submitter_scope,metadata)
        VALUES ($1,$2,$3,$4,'pending','web',now(),now(),$5,$3,'{}'::jsonb)
      `, [runId, sessionId, user, tenantId, key]);
      await client.query('COMMIT');
      return runId;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const newEnqueue = (runId: string, sessionId: string, tenantId: string, user: string, key: string) => (
    store.enqueueUserMessage({
      runId, sessionId, tenantId, userId: user, submitterUserId: user,
      idempotencyKey: key, channel: 'web',
    }, 'queue')
  );

  const oldStop = (sessionId: string, stoppedAt = new Date().toISOString()) => pool.query(`
    INSERT INTO ${prefix}_steering_sessions (session_id,stopped_at)
    VALUES ($1,$2) ON CONFLICT (session_id) DO UPDATE
    SET stopped_at=GREATEST(${prefix}_steering_sessions.stopped_at,EXCLUDED.stopped_at)
  `, [sessionId, stoppedAt]);

  it('expand keeps raw global arbiters and one authority in both writer directions', async () => {
    const newFirst = await newEnqueue('new-first', 'new-first-session', 'tenant-overlap', 'overlap-user', 'new-first-key');
    await expect(oldEnqueue(
      'old-retry', 'new-first-session', 'tenant-overlap', 'overlap-user', 'new-first-key',
    )).resolves.toBe(newFirst.runId);

    await expect(oldEnqueue(
      'old-first', 'old-first-session', 'tenant-overlap', 'overlap-user', 'old-first-key',
    )).resolves.toBe('old-first');
    await expect(newEnqueue(
      'new-retry', 'old-first-session', 'tenant-overlap', 'overlap-user', 'old-first-key',
    )).resolves.toMatchObject({ runId: 'old-first' });

    const directions = [['new', 'old'], ['old', 'new'], ['new', 'new']] as const;
    for (const [index, directionsForRace] of directions.entries()) {
      const write = (generation: 'new' | 'old', side: string) => generation === 'new'
        ? newEnqueue(`race-${index}-${side}`, `race-session-${index}`, 'tenant-overlap', 'race-user', `race-key-${index}`)
          .then((run) => run.runId)
        : oldEnqueue(`race-${index}-${side}`, `race-session-${index}`, 'tenant-overlap', 'race-user', `race-key-${index}`);
      const ids = await Promise.all([write(directionsForRace[0], 'a'), write(directionsForRace[1], 'b')]);
      expect(new Set(ids).size, directionsForRace.join('→')).toBe(1);
    }

    const physical = await pool.query(`
      SELECT user_scope,client_message_id,tenant_id,tenant_user_scope,tenant_client_message_id
      FROM ${prefix}_message_submissions WHERE run_id='new-first'
    `);
    expect(physical.rows).toEqual([{
      user_scope: 'overlap-user', client_message_id: 'new-first-key', tenant_id: 'tenant-overlap',
      tenant_user_scope: 'overlap-user', tenant_client_message_id: 'new-first-key',
    }]);
    const primaryKey = await pool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
      WHERE conrelid='${prefix}_message_submissions'::regclass AND contype='p'
    `);
    expect(primaryKey.rows[0]?.definition).toContain('(user_scope, client_message_id)');
  });

  it('expand fails cross-tenant raw submission reuse closed without leaks or 23505', async () => {
    await newEnqueue('owner-run', 'owner-session', 'owner-tenant', 'shared-user', 'shared-key');
    for (const runId of ['foreign-attempt-1', 'foreign-attempt-2']) {
      await expect(newEnqueue(
        runId, 'foreign-session', 'foreign-tenant', 'shared-user', 'shared-key',
      )).rejects.toThrow('conflicts with another tenant during run-store expand phase');
    }
    const visible = await pool.query(`
      SELECT tenant_id,run_id FROM ${prefix}_message_submissions
      WHERE user_scope='shared-user' AND client_message_id='shared-key'
    `);
    expect(visible.rows).toEqual([{ tenant_id: 'owner-tenant', run_id: 'owner-run' }]);
    await expect(pool.query(`SELECT run_id FROM ${prefix}_runs WHERE tenant_id='foreign-tenant'`))
      .resolves.toMatchObject({ rows: [] });

    const raced = await Promise.allSettled([
      newEnqueue('cross-race-a', 'cross-race-session', 'cross-race-a', 'cross-user', 'cross-key'),
      newEnqueue('cross-race-b', 'cross-race-session', 'cross-race-b', 'cross-user', 'cross-key'),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = raced.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({ status: 'rejected' });
    if (rejection?.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(RunCreateConflictError);
      expect((rejection.reason as { code?: string }).code).not.toBe('23505');
    }
  });

  it('expand unifies steering stop/read authority and rejects another tenant', async () => {
    await store.upsertPending({ runId: 'new-stop-run', sessionId: 'new-stop-session', tenantId: 'steer-tenant' });
    await store.cancelSteeringBeforeDispatchBySession('new-stop-session', 'new-stop', undefined, 'steer-tenant');
    await expect(oldStop('new-stop-session')).resolves.toMatchObject({ rowCount: 1 });

    await store.upsertPending({ runId: 'old-stop-run', sessionId: 'old-stop-session', tenantId: 'steer-tenant' });
    const oldStoppedAt = new Date().toISOString();
    await oldStop('old-stop-session', oldStoppedAt);
    await store.cancelSteeringBeforeDispatchBySession('old-stop-session', 'new-retry', undefined, 'steer-tenant');
    await expect(store.enqueueUserMessage({
      runId: 'stale-steer', sessionId: 'old-stop-session', tenantId: 'steer-tenant',
      userId: 'steer-user', idempotencyKey: 'stale-steer', channel: 'web',
      metadata: { steeringAcceptedAt: new Date(Date.parse(oldStoppedAt) - 1_000).toISOString() },
    }, 'steer')).rejects.toThrow('accepted before the latest session stop');

    await store.upsertPending({ runId: 'other-stop-run', sessionId: 'new-stop-session', tenantId: 'other-steer-tenant' });
    await expect(store.cancelSteeringBeforeDispatchBySession(
      'new-stop-session', 'foreign-stop', undefined, 'other-steer-tenant',
    )).rejects.toThrow('Steering session key conflicts with another tenant');
    const authorities = await pool.query(`
      SELECT session_id,tenant_id,tenant_session_id FROM ${prefix}_steering_sessions
      WHERE session_id IN ('new-stop-session','old-stop-session') ORDER BY session_id
    `);
    expect(authorities.rows).toEqual([
      { session_id: 'new-stop-session', tenant_id: 'steer-tenant', tenant_session_id: 'new-stop-session' },
      { session_id: 'old-stop-session', tenant_id: 'steer-tenant', tenant_session_id: 'old-stop-session' },
    ]);
  });

  it('contracts idempotently behind the drain gate, then permits tenant-native coexistence', async () => {
    await expect(store.contractTenantSchema({
      expectedExpandVersion: 0, oldWritersDrained: true,
    } as never)).rejects.toThrow('contract gate rejected');
    await pool.query(`
      INSERT INTO ${prefix}_message_submissions
        (user_scope,client_message_id,run_id,session_id,delivery_mode,accepted_at)
      VALUES ('orphan-user','orphan-key','missing-run','missing-session','queue',now())
    `);

    const confirmedDrainGate = {
      expectedExpandVersion: RUN_STORE_TENANT_SCHEMA_VERSION,
      oldWritersDrained: true,
    } as const;
    await store.contractTenantSchema(confirmedDrainGate);
    await expect(store.contractTenantSchema(confirmedDrainGate)).resolves.toBeUndefined();

    const columns = await pool.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name='${prefix}_message_submissions'
        AND column_name IN ('tenant_id','tenant_user_scope','tenant_client_message_id')
    `);
    expect(columns.rows.every((row) => row.is_nullable === 'NO')).toBe(true);
    const primaryKeys = await pool.query<{ table_name: string; definition: string }>(`
      SELECT c.conrelid::regclass::text table_name,pg_get_constraintdef(c.oid) definition
      FROM pg_constraint c WHERE c.conrelid IN (
        '${prefix}_message_submissions'::regclass,'${prefix}_steering_sessions'::regclass
      ) AND c.contype='p' ORDER BY table_name
    `);
    expect(primaryKeys.rows.map((row) => row.definition)).toEqual(expect.arrayContaining([
      expect.stringContaining('(tenant_id, tenant_user_scope, tenant_client_message_id)'),
      expect.stringContaining('(tenant_id, tenant_session_id)'),
    ]));
    await expect(pool.query(`SELECT payload->>'run_id' run_id FROM ${prefix}_message_submissions_tenant_quarantine`))
      .resolves.toMatchObject({ rows: [{ run_id: 'missing-run' }] });

    const [tenantA, tenantB] = await Promise.all([
      newEnqueue('contract-a', 'contract-session-a', 'contract-a', 'contract-user', 'contract-key'),
      newEnqueue('contract-b', 'contract-session-b', 'contract-b', 'contract-user', 'contract-key'),
    ]);
    expect([tenantA.runId, tenantB.runId].sort()).toEqual(['contract-a', 'contract-b']);
    await Promise.all([
      store.upsertPending({ runId: 'contract-stop-a', sessionId: 'contract-stop', tenantId: 'contract-a' }),
      store.upsertPending({ runId: 'contract-stop-b', sessionId: 'contract-stop', tenantId: 'contract-b' }),
    ]);
    await Promise.all([
      store.cancelSteeringBeforeDispatchBySession('contract-stop', 'stop-a', undefined, 'contract-a'),
      store.cancelSteeringBeforeDispatchBySession('contract-stop', 'stop-b', undefined, 'contract-b'),
    ]);
    await expect(pool.query(`
      SELECT tenant_id,session_id FROM ${prefix}_steering_sessions
      WHERE tenant_session_id='contract-stop' ORDER BY tenant_id
    `)).resolves.toMatchObject({ rows: [
      { tenant_id: 'contract-a', session_id: 'contract-stop' },
      { tenant_id: 'contract-b', session_id: 'contract-stop' },
    ] });
  });
});
