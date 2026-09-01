import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { RUN_STORE_TENANT_SCHEMA_VERSION } from '../runtime/runStoreSchema.js';
import { RunCreateConflictError } from '../runtime/runStoreTypes.js';
import { describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

function roleConnectionString(connectionString: string, role: string, password: string): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = password;
  return url.toString();
}

describePg('PgRunStore capability-fenced two-phase tenant migration', () => {
  const prefix = `rolling_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;
  let nativeStore: PgRunStore;
  let roleFenceAvailable = false; // Set when the PG test identity may create non-super roles.
  const legacyRoles = new Map<string, string>();
  const legacyPools = new Map<string, InstanceType<typeof Pool>>();
  let nativeRole: string | undefined;
  let nativePool: InstanceType<typeof Pool> | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    store = new PgRunStore({ pool, tablePrefix: prefix,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true } });
    await store.init();
    const privilege = await pool.query<{ allowed: boolean }>(`
      SELECT rolsuper OR rolcreaterole allowed FROM pg_roles WHERE rolname=current_user
    `);
    roleFenceAvailable = privilege.rows[0]?.allowed === true;
    if (!roleFenceAvailable) { nativeStore = store; return; }
    for (const [index, tenantId] of [
      'tenant-overlap', 'steer-tenant', 'matrix-a', 'matrix-b',
    ].entries()) {
      const role = `${prefix}_legacy_${index}`;
      const password = randomUUID();
      const ddl = await pool.query<{ sql: string }>(`SELECT format('CREATE ROLE %I LOGIN PASSWORD %L',$1::text,$2::text) sql`, [role, password]);
      await pool.query(ddl.rows[0]!.sql);
      await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${prefix}_runs,
        ${prefix}_message_submissions,${prefix}_steering_inputs,${prefix}_steering_sessions TO ${role}`);
      await pool.query(`GRANT USAGE,SELECT ON SEQUENCE ${prefix}_runs_enqueue_seq_seq,
        ${prefix}_steering_inputs_sequence_seq TO ${role}`);
      await store.registerLegacyWriterCapability({ dbRole: role, tenantId });
      legacyRoles.set(tenantId, role);
      const rolePool = new Pool({ connectionString: roleConnectionString(testPgUrl!, role, password), max: 4 });
      await expect(rolePool.query<{ session_user: string }>('SELECT session_user')).resolves.toMatchObject({
        rows: [{ session_user: role }],
      });
      legacyPools.set(tenantId, rolePool);
    }
    nativeRole = `${prefix}_tenant_native`;
    const nativePassword = randomUUID();
    const nativeDdl = await pool.query<{ sql: string }>(
      `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L',$1::text,$2::text) sql`, [nativeRole, nativePassword]);
    await pool.query(nativeDdl.rows[0]!.sql);
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${prefix}_runs,
      ${prefix}_message_submissions,${prefix}_steering_inputs,${prefix}_steering_sessions TO ${nativeRole}`);
    await pool.query(`GRANT USAGE,SELECT ON SEQUENCE ${prefix}_runs_enqueue_seq_seq,
      ${prefix}_steering_inputs_sequence_seq TO ${nativeRole}`);
    await store.registerTenantNativeWriterCapability(nativeRole);
    nativePool = new Pool({
      connectionString: roleConnectionString(testPgUrl!, nativeRole, nativePassword), max: 8,
    });
    await expect(nativePool.query<{ session_user: string }>('SELECT session_user')).resolves.toMatchObject({
      rows: [{ session_user: nativeRole }],
    });
    nativeStore = new PgRunStore({ pool: nativePool, tablePrefix: prefix });
  }, 30_000);

  afterAll(async () => { // remove per-prefix migration objects
    if (!pool) return;
    for (const suffix of [
      'steering_sessions_tenant_quarantine', 'steering_inputs_tenant_quarantine',
      'message_submissions_tenant_quarantine', 'steering_sessions', 'steering_inputs',
      'message_submissions', 'runs_writer_capabilities', 'runs_schema_migrations', 'runs',
    ]) await pool.query(`DROP TABLE IF EXISTS ${prefix}_${suffix} CASCADE`);
    for (const fn of ['message_submissions_tenant_expand_fn', 'steering_inputs_tenant_expand_fn',
      'steering_sessions_tenant_expand_fn', 'runs_writer_capability_fn',
      'runs_tenant_aux_catchup_fn']) {
      await pool.query(`DROP FUNCTION IF EXISTS ${prefix}_${fn}()`);
    }
    for (const rolePool of legacyPools.values()) await rolePool.end();
    if (nativePool) await nativePool.end();
    for (const role of [...legacyRoles.values(), ...(nativeRole ? [nativeRole] : [])]) {
      const ddl = await pool.query<{ sql: string }>(`SELECT format('DROP ROLE IF EXISTS %I',$1::text) sql`, [role]);
      await pool.query(ddl.rows[0]!.sql);
    }
    await pool.end();
  }, 30_000);

  // Exact pre-capability SQL used by the legacy writer.
  const oldEnqueue = async (runId: string, sessionId: string, tenantId: string, user: string, key: string) => {
    const writerPool = legacyPools.get(tenantId)
      ?? (tenantId === 'contract-a' ? legacyPools.get('matrix-a') : undefined) ?? pool;
    const client = await writerPool.connect();
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
    nativeStore.enqueueUserMessage({
      runId, sessionId, tenantId, userId: user, submitterUserId: user,
      idempotencyKey: key, channel: 'web',
    }, 'queue')
  );

  const oldStop = async (
    tenantId: string, sessionId: string, stoppedAt = new Date().toISOString(),
  ) => {
    const writerPool = legacyPools.get(tenantId)
      ?? (tenantId === 'contract-a' ? legacyPools.get('matrix-a') : undefined) ?? pool;
    const client = await writerPool.connect();
    try {
      return await client.query(`
        INSERT INTO ${prefix}_steering_sessions (session_id,stopped_at)
        VALUES ($1,$2) ON CONFLICT (session_id) DO UPDATE
        SET stopped_at=GREATEST(${prefix}_steering_sessions.stopped_at,EXCLUDED.stopped_at)
      `, [sessionId, stoppedAt]);
    } finally {
      client.release();
    }
  };

  const oldReadStops = async (tenantId: string, sessionId: string) => {
    const writerPool = legacyPools.get(tenantId)
      ?? (tenantId === 'contract-a' ? legacyPools.get('matrix-a') : undefined) ?? pool;
    const client = await writerPool.connect();
    try {
      return (await client.query(`SELECT tenant_id,stopped_at FROM ${prefix}_steering_sessions
        WHERE session_id=$1`, [sessionId])).rows;
    } finally {
      client.release();
    }
  };

  it('rejects an explicit shared-role capability mislabel instead of switching registration', async () => {
    const mislabeled = new PgRunStore({ pool, tablePrefix: prefix, writerCapability: {
      capability: 'legacy-single-tenant', tenantId: 'wrong-tenant', allowPrivilegedRoleForTests: true,
    } });
    await expect(mislabeled.init()).rejects.toThrow('immutable capability declaration');
  });

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
      )).rejects.toThrow('shared authority is closed until durable legacy-writer drain evidence');
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

  it('database roles fence old/new cross-tenant enqueue, concurrency, stop and read matrices', async () => {
    if (!roleFenceAvailable) return; // Limited CI roles cannot create independent LOGIN roles; provider PG normally can.

    await Promise.all([
      store.upsertPending({ runId: 'matrix-runs-a', sessionId: 'matrix-runs-a-session', tenantId: 'matrix-a' }),
      store.upsertPending({ runId: 'matrix-runs-b', sessionId: 'matrix-runs-b-session', tenantId: 'matrix-b' }),
    ]);
    const matrixB = legacyPools.get('matrix-b')!;
    await expect(matrixB.query(`SELECT run_id FROM ${prefix}_runs WHERE run_id='matrix-runs-a'`))
      .resolves.toMatchObject({ rows: [] });
    await expect(matrixB.query(`UPDATE ${prefix}_runs SET status='running'
      WHERE run_id='matrix-runs-a' RETURNING run_id`)).resolves.toMatchObject({ rows: [], rowCount: 0 });
    await expect(matrixB.query(`DELETE FROM ${prefix}_runs WHERE run_id='matrix-runs-a'
      RETURNING run_id`)).resolves.toMatchObject({ rows: [], rowCount: 0 });
    await expect(matrixB.query(`SELECT run_id,status FROM ${prefix}_runs WHERE run_id='matrix-runs-b'`))
      .resolves.toMatchObject({ rows: [{ run_id: 'matrix-runs-b', status: 'pending' }] });
    await expect(matrixB.query(`UPDATE ${prefix}_runs SET status='running'
      WHERE run_id='matrix-runs-b' RETURNING run_id`))
      .resolves.toMatchObject({ rows: [{ run_id: 'matrix-runs-b' }], rowCount: 1 });
    await expect(matrixB.query(`DELETE FROM ${prefix}_runs WHERE run_id='matrix-runs-b'
      RETURNING run_id`)).resolves.toMatchObject({ rows: [{ run_id: 'matrix-runs-b' }], rowCount: 1 });

    await newEnqueue('matrix-new-a', 'matrix-new-a-session', 'matrix-a', 'matrix-user', 'new-a-old-b');
    await expect(oldEnqueue(
      'matrix-old-b-hidden', 'matrix-old-b-session', 'matrix-b', 'matrix-user', 'new-a-old-b',
    )).resolves.toBeUndefined();
    await expect(store.findByIdempotencyKey('matrix-b', 'matrix-user', 'new-a-old-b'))
      .resolves.toBeNull();

    await expect(oldEnqueue(
      'matrix-old-a', 'matrix-old-a-session', 'matrix-a', 'matrix-user', 'old-a-new-b',
    )).resolves.toBe('matrix-old-a');
    await expect(newEnqueue(
      'matrix-new-b-rejected', 'matrix-new-b-session', 'matrix-b', 'matrix-user', 'old-a-new-b',
    )).rejects.toThrow('shared authority is closed until durable legacy-writer drain evidence');
    await expect(store.findByIdempotencyKey('matrix-b', 'matrix-user', 'old-a-new-b'))
      .resolves.toBeNull();

    const concurrent = await Promise.allSettled([
      oldEnqueue('matrix-race-old-a', 'matrix-race-session', 'matrix-a', 'matrix-race', 'matrix-race-key'),
      newEnqueue('matrix-race-new-b', 'matrix-race-session', 'matrix-b', 'matrix-race', 'matrix-race-key'),
    ]);
    expect(concurrent.some((result) => result.status === 'fulfilled')).toBe(true);
    const matrixBResult = await store.findByIdempotencyKey('matrix-b', 'matrix-race', 'matrix-race-key');
    expect(matrixBResult?.runId).not.toBe('matrix-race-old-a');

    await Promise.all([
      store.upsertPending({ runId: 'matrix-stop-a', sessionId: 'matrix-stop', tenantId: 'matrix-a' }),
      store.upsertPending({ runId: 'matrix-stop-b', sessionId: 'matrix-stop', tenantId: 'matrix-b' }),
    ]);
    await store.cancelSteeringBeforeDispatchBySession('matrix-stop', 'matrix-stop-a', undefined, 'matrix-a');
    await expect(oldReadStops('matrix-b', 'matrix-stop')).resolves.toEqual([]);
    await expect(oldStop('matrix-b', 'matrix-stop')).rejects.toThrow();
    await expect(oldReadStops('matrix-b', 'matrix-stop')).resolves.toEqual([]);
    await expect(oldReadStops('matrix-a', 'matrix-stop')).resolves.toHaveLength(1);
  });

  it('expand unifies steering stop/read authority and rejects another tenant', async () => {
    await store.upsertPending({ runId: 'new-stop-run', sessionId: 'new-stop-session', tenantId: 'steer-tenant' });
    await store.cancelSteeringBeforeDispatchBySession('new-stop-session', 'new-stop', undefined, 'steer-tenant');
    await expect(oldStop('steer-tenant', 'new-stop-session')).resolves.toMatchObject({ rowCount: 1 });

    await store.upsertPending({ runId: 'old-stop-run', sessionId: 'old-stop-session', tenantId: 'steer-tenant' });
    const oldStoppedAt = new Date().toISOString();
    await oldStop('steer-tenant', 'old-stop-session', oldStoppedAt);
    await store.cancelSteeringBeforeDispatchBySession('old-stop-session', 'new-retry', undefined, 'steer-tenant');
    await expect(store.enqueueUserMessage({
      runId: 'stale-steer', sessionId: 'old-stop-session', tenantId: 'steer-tenant',
      userId: 'steer-user', idempotencyKey: 'stale-steer', channel: 'web',
      metadata: { steeringAcceptedAt: new Date(Date.parse(oldStoppedAt) - 1_000).toISOString() },
    }, 'steer')).rejects.toThrow('accepted before the latest session stop');

    await store.upsertPending({ runId: 'other-stop-run', sessionId: 'new-stop-session', tenantId: 'other-steer-tenant' });
    await expect(store.cancelSteeringBeforeDispatchBySession(
      'new-stop-session', 'foreign-stop', undefined, 'other-steer-tenant',
    )).rejects.toThrow('steering authority is closed until durable legacy-writer drain evidence');
    const authorities = await pool.query(`
      SELECT session_id,tenant_id,tenant_session_id FROM ${prefix}_steering_sessions
      WHERE session_id IN ('new-stop-session','old-stop-session') ORDER BY session_id
    `);
    expect(authorities.rows).toEqual([
      { session_id: 'new-stop-session', tenant_id: 'steer-tenant', tenant_session_id: 'new-stop-session' },
      { session_id: 'old-stop-session', tenant_id: 'steer-tenant', tenant_session_id: 'old-stop-session' },
    ]);
  });

  it('contracts idempotently behind database-observed drain evidence, then permits tenant-native coexistence', async () => {
    await expect(store.contractTenantSchema({
      expectedExpandVersion: 0, drainEvidenceId: 'missing',
    } as never)).rejects.toThrow('contract gate rejected');
    if (roleFenceAvailable) {
      await expect(store.recordTenantDrainEvidence({
        evidenceId: 'premature-drain', capability: 'tenant-native-v1',
        observer: 'rolling-pg-test',
      })).rejects.toThrow('legacy roles NOLOGIN, disabled, and inactive');
      for (const role of legacyRoles.values()) await store.disableLegacyWriterCapability(role);
      await expect(legacyPools.values().next().value!.query('SELECT 1')).rejects.toBeDefined();
    }
    await pool.query(`
      INSERT INTO ${prefix}_message_submissions
        (user_scope,client_message_id,run_id,session_id,delivery_mode,accepted_at)
      VALUES ('orphan-user','orphan-key','missing-run','missing-session','queue',now())
    `);

    const confirmedDrainGate = { // evidence id must already be durable
      expectedExpandVersion: RUN_STORE_TENANT_SCHEMA_VERSION,
      drainEvidenceId: 'rolling-drain-evidence',
    } as const;
    await expect(store.contractTenantSchema(confirmedDrainGate))
      .rejects.toThrow('matching durable drain evidence');
    await store.recordTenantDrainEvidence({
      evidenceId: confirmedDrainGate.drainEvidenceId, capability: 'tenant-native-v1',
      observer: 'rolling-pg-test',
    });
    await store.contractTenantSchema(confirmedDrainGate);
    await expect(store.contractTenantSchema(confirmedDrainGate)).resolves.toBeUndefined();
    await expect(oldEnqueue(
      'legacy-after-contract', 'legacy-after-contract', 'contract-a', 'contract-user', 'legacy-key',
    )).rejects.toBeDefined();

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
    expect(primaryKeys.rows.map((row) => row.definition)).toEqual(expect.arrayContaining([ // contracted keys
      expect.stringContaining('(tenant_id, tenant_user_scope, tenant_client_message_id)'),
      expect.stringContaining('(tenant_id, tenant_session_id)'),
    ]));
    await expect(pool.query(`SELECT payload->>'run_id' run_id FROM ${prefix}_message_submissions_tenant_quarantine`))
      .resolves.toMatchObject({ rows: [{ run_id: 'missing-run' }] });

    const [tenantA, tenantB] = await Promise.all([
      newEnqueue('contract-a', 'contract-session-a', 'contract-a', 'contract-user', 'contract-key'),
      newEnqueue('contract-b', 'contract-session-b', 'contract-b', 'contract-user', 'contract-key'),
    ]);
    expect([tenantA.runId, tenantB.runId].sort()).toEqual(['contract-a', 'contract-b']); // tenant-native coexistence
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

    if (roleFenceAvailable) {
      const legacyRole = `${prefix}_unregistered_legacy`;
      const password = randomUUID();
      const create = await pool.query<{ sql: string }>(
        `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L',$1::text,$2::text) sql`, [legacyRole, password]);
      await pool.query(create.rows[0]!.sql);
      await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${prefix}_runs,
        ${prefix}_steering_sessions TO ${legacyRole}`);
      const legacyPool = new Pool({
        connectionString: roleConnectionString(testPgUrl!, legacyRole, password), max: 1,
      });
      try {
        await expect(legacyPool.query<{ session_user: string }>('SELECT session_user')).resolves.toMatchObject({
          rows: [{ session_user: legacyRole }],
        });
        await expect(legacyPool.query(`SELECT run_id FROM ${prefix}_runs
          WHERE run_id='contract-a'`)).rejects.toMatchObject({ code: '42501' });
        await expect(legacyPool.query(`UPDATE ${prefix}_runs SET status='running'
          WHERE run_id='contract-a'`)).rejects.toMatchObject({ code: '42501' });
        await expect(legacyPool.query(`DELETE FROM ${prefix}_runs
          WHERE run_id='contract-a'`)).rejects.toMatchObject({ code: '42501' });
        await expect(legacyPool.query(`SELECT stopped_at FROM ${prefix}_steering_sessions
          WHERE session_id='contract-stop'`)).rejects.toMatchObject({ code: '42501' });
        await expect(legacyPool.query(`UPDATE ${prefix}_steering_sessions SET stopped_at=now()
          WHERE session_id='contract-stop'`)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await legacyPool.end();
        const dropOwned = await pool.query<{ sql: string }>(
          `SELECT format('DROP OWNED BY %I',$1::text) sql`, [legacyRole]);
        await pool.query(dropOwned.rows[0]!.sql);
        const drop = await pool.query<{ sql: string }>(`SELECT format('DROP ROLE %I',$1::text) sql`, [legacyRole]);
        await pool.query(drop.rows[0]!.sql);
      }
    }
  });
});
