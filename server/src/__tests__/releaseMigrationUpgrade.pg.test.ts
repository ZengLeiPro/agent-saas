import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PgGovernanceMigrationRunner, GOVERNANCE_SCHEMA_VERSION, governanceMigrationVersions } from '../data/governance-schema/migrations.js';
import { governanceV39OrgGroupBindingIdentityStatements } from '../data/governance-schema/v39OrgGroupBindingIdentityMigration.js';
import { governanceV40DwsDeliveryAccountIdentityStatements } from '../data/governance-schema/v40DwsDeliveryAccountIdentityMigration.js';
import { PgProviderQuotaSnapshotStore } from '../quota/providerQuotaSnapshotStore.js';
import { PgSessionLock } from '../runtime/pgSessionLock.js';
import { initializePgRunStore, type PgRunStoreSchemaTarget } from '../runtime/runStoreSchema.js';
import { applySessionAutomationSchema } from '../runtime/sessionAutomationStoreSchema.js';
import { describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';
import { loadReleaseMigrationBaseline } from './releaseMigrationBaseline.js';

describePg('真实生产基线的迁移与回滚兼容性', () => {
  const prefix = `mu_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testPgUrl, max: 8 });
  });
  afterAll(async () => {
    // 只清理本测试随机前缀创建的对象，所有测试都在专用测试数据库运行。
    const tables = await pool.query<{ statement: string }>(
      `SELECT format('DROP TABLE %I CASCADE',relname) AS statement FROM pg_class
       WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND starts_with(relname,$1)`,
      [prefix],
    );
    for (const row of tables.rows) await pool.query(row.statement);
    const functions = await pool.query<{ statement: string }>(
      `SELECT format('DROP FUNCTION %s CASCADE',oid::regprocedure) AS statement FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND starts_with(proname,$1)`,
      [prefix],
    );
    for (const row of functions.rows) await pool.query(row.statement);
    await pool.end();
  });

  it('旧版 Run Store 建表、带数据升级、旧写入和旧初始化回滚后均保留数据', async () => {
    const old = await loadReleaseMigrationBaseline<{
      initializePgRunStoreSchema(input: PgRunStoreSchemaTarget): Promise<void>;
    }>('server/src/runtime/runStoreSchema.ts');
    const oldRuntime = await loadReleaseMigrationBaseline<{
      PgRunStore: new (options: { pool: pg.Pool; tablePrefix: string }) => {
        enqueueUserMessage(input: Record<string, string>, mode: string): Promise<unknown>;
      };
    }>('server/src/runtime/runStore.ts');
    const oldStore = new oldRuntime.PgRunStore({ pool, tablePrefix: prefix });
    const input: PgRunStoreSchemaTarget = {
      pool,
      runsTable: `${prefix}_runs`,
      messageSubmissionsTable: `${prefix}_message_submissions`,
      steeringInputsTable: `${prefix}_steering_inputs`,
      steeringSessionsTable: `${prefix}_steering_sessions`,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    };
    const oldWrite = async (id: string) => {
      await oldStore.enqueueUserMessage(
        {
          runId: id,
          sessionId: id,
          tenantId: 'kaiyan',
          userId: 'old-user',
          submitterUserId: 'old-user',
          idempotencyKey: id,
          channel: 'web',
        },
        'queue',
      );
    };
    await old.initializePgRunStoreSchema(input);
    await oldWrite('before');
    await initializePgRunStore(input);
    await oldWrite('during');
    const client = await pool.connect();
    try {
      await applySessionAutomationSchema(client, prefix, input.runsTable);
      await applySessionAutomationSchema(client, prefix, input.runsTable);
    } finally {
      client.release();
    }
    await old.initializePgRunStoreSchema(input);
    await oldWrite('rollback');
    await initializePgRunStore(input);
    const rows = await pool.query(
      `SELECT run_id,tenant_id,user_scope FROM ${input.messageSubmissionsTable} ORDER BY run_id`,
    );
    expect(rows.rows).toEqual(
      ['before', 'during', 'rollback'].map((run_id) => ({
        run_id,
        tenant_id: 'kaiyan',
        user_scope: 'old-user',
      })),
    );
    expect(
      (await pool.query(`SELECT phase FROM ${input.runsTable}_schema_migrations`)).rows,
    ).toEqual([{ phase: 'expand' }]);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM ${input.messageSubmissionsTable}_tenant_quarantine`,
        )
      ).rows[0].n,
    ).toBe(0);
  }, 30_000);

  it('新旧 session lease 互斥，旧实例可续用升级后的兼容表', async () => {
    type OldHandle = { release(): Promise<void> };
    const old = await loadReleaseMigrationBaseline<{
      PgSessionLock: new (options: { pool: pg.Pool; tablePrefix: string; mode: string }) => {
        init(): Promise<void>;
        tryAcquire(session: string): Promise<OldHandle | null>;
      };
    }>('server/src/runtime/pgSessionLock.ts');
    const before = new old.PgSessionLock({ pool, tablePrefix: `${prefix}_l`, mode: 'dual' });
    const after = new PgSessionLock({ pool, tablePrefix: `${prefix}_l`, mode: 'lease' });
    await before.init();
    const oldHandle = await before.tryAcquire('session');
    expect(oldHandle).not.toBeNull();
    try {
      await after.init();
      expect(await after.tryAcquire('kaiyan', 'session')).toBeNull();
    } finally {
      await oldHandle?.release();
    }
    const newHandle = await after.tryAcquire('kaiyan', 'session');
    expect(newHandle).not.toBeNull();
    try {
      expect(await before.tryAcquire('session')).toBeNull();
    } finally {
      await newHandle?.release();
    }
    await before.init();
    const rollbackHandle = await before.tryAcquire('session');
    expect(rollbackHandle).not.toBeNull();
    await rollbackHandle?.release();
  }, 30_000);

  it('真实 v37 治理数据库可升级到当前版本、重复运行并由旧 runner 重启', async () => {
    const old = await loadReleaseMigrationBaseline<{
      PgGovernanceMigrationRunner: typeof PgGovernanceMigrationRunner;
    }>('server/src/data/governance-schema/migrations.ts');
    const previous = new old.PgGovernanceMigrationRunner(pool, `${prefix}_g`);
    await previous.run();
    const current = new PgGovernanceMigrationRunner(pool, `${prefix}_g`);
    await current.run();
    await current.run();
    await previous.run();
    expect(
      (
        await pool.query(
          `SELECT version FROM ${prefix}_g_governance_schema_versions WHERE version>=37 ORDER BY version`,
        )
      ).rows,
    ).toEqual(
      governanceMigrationVersions().filter((version) => version > 36).map((version) => ({ version })),
    );
    const quota = new PgProviderQuotaSnapshotStore(pool, { tablePrefix: prefix });
    await quota.init();
    await quota.init();
    expect(await quota.latest()).toEqual([]);
  }, 30_000);

  it('v39 只回填匹配身份，v40 允许旧全空行并拒绝不完整新身份', async () => {
    const p = `${prefix}_i`;
    await pool.query(
      `CREATE TABLE ${p}_agent_dws_accounts (tenant_id text,account_id text,profile_id text,corp_id text,dingtalk_user_id text,identity_updated_at timestamptz)`,
    );
    await pool.query(
      `CREATE TABLE ${p}_org_agent_channel_bindings (tenant_id text,account_id text,created_at timestamptz)`,
    );
    await pool.query(`CREATE TABLE ${p}_agent_dws_delivery_intents (id text PRIMARY KEY)`);
    await pool.query(
      `INSERT INTO ${p}_agent_dws_accounts VALUES ('t','a','c:u','c','u','2026-01-02')`,
    );
    await pool.query(
      `INSERT INTO ${p}_org_agent_channel_bindings VALUES ('t','a','2026-01-01'),('t','a','2026-01-03')`,
    );
    await pool.query(`INSERT INTO ${p}_agent_dws_delivery_intents VALUES ('old')`);
    for (const sql of [
      ...governanceV39OrgGroupBindingIdentityStatements(p),
      ...governanceV40DwsDeliveryAccountIdentityStatements(p),
    ])
      await pool.query(sql);
    expect(
      (
        await pool.query(
          `SELECT account_profile_id FROM ${p}_org_agent_channel_bindings ORDER BY created_at`,
        )
      ).rows,
    ).toEqual([{ account_profile_id: null }, { account_profile_id: 'c:u' }]);
    await pool.query(`INSERT INTO ${p}_agent_dws_delivery_intents (id) VALUES ('rollback')`);
    await expect(
      pool.query(
        `INSERT INTO ${p}_agent_dws_delivery_intents (id,account_profile_id) VALUES ('partial','c:u')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      `INSERT INTO ${p}_agent_dws_delivery_intents VALUES ('new','c:u','c','u',now())`,
    );
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM ${p}_agent_dws_delivery_intents`)).rows[0]
        .n,
    ).toBe(3);
  });
});
