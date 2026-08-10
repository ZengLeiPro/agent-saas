import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PgGovernanceMigrationRunner,
  type GovernancePgPool,
} from '../data/governance-schema/migrations.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Governance Schema V17 PostgreSQL 升级与事务回滚', () => {
  const prefix = `govv17_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;

  beforeAll(() => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const tables = await pool.query<{ tablename: string }>(`
        SELECT tablename FROM pg_tables
        WHERE schemaname=current_schema() AND LEFT(tablename,LENGTH($1))=$1
      `, [prefix]);
      for (const row of tables.rows) {
        await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }
      const functions = await pool.query<{ proname: string; args: string }>(`
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=current_schema() AND LEFT(p.proname,LENGTH($1))=$1
      `, [prefix]);
      for (const row of functions.rows) {
        await pool.query(`DROP FUNCTION IF EXISTS "${row.proname}"(${row.args}) CASCADE`);
      }
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('V17 中途失败回滚到 V16，重试后升级并让八类 authority mutation 原子入 outbox', async () => {
    let injected = false;
    const failingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: readonly unknown[]) => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            if (!injected && normalized.includes(`CREATE INDEX ${prefix}_run_resolution_snapshots_latest_idx`)) {
              injected = true;
              throw new Error('INJECTED_V17_FAILURE');
            }
            return client.query(text, values as never);
          },
          release: () => client.release(),
        };
      },
    } as unknown as GovernancePgPool;

    await expect(new PgGovernanceMigrationRunner(failingPool, prefix).run())
      .rejects.toThrow('INJECTED_V17_FAILURE');

    const rolledBackVersion = await pool.query<{ version: number }>(
      `SELECT MAX(version) AS version FROM ${prefix}_governance_schema_versions`,
    );
    expect(Number(rolledBackVersion.rows[0]?.version)).toBe(16);
    const rolledBackIndex = await pool.query<{ name: string | null }>(
      'SELECT to_regclass($1) AS name',
      [`${prefix}_run_resolution_snapshots_latest_idx`],
    );
    expect(rolledBackIndex.rows[0]?.name).toBe(`${prefix}_run_resolution_snapshots_latest_idx`);
    const prematureTriggers = await pool.query<{ count: string }>(`
      SELECT count(*) AS count FROM pg_trigger
      WHERE NOT tgisinternal AND LEFT(tgname,LENGTH($1))=$1
    `, [`${prefix}_`]);
    expect(Number(prematureTriggers.rows[0]?.count)).toBe(0);

    const runner = new PgGovernanceMigrationRunner(pool, prefix);
    await runner.run();
    await runner.run();

    const appliedVersions = await pool.query<{ version: number }>(
      `SELECT version FROM ${prefix}_governance_schema_versions ORDER BY version`,
    );
    expect(appliedVersions.rows.map(row => Number(row.version))).toEqual(
      Array.from({ length: 17 }, (_, index) => index + 1),
    );

    const expectedTriggers = [
      `${prefix}_membership_projection_outbox`,
      `${prefix}_platform_admin_projection_outbox`,
      `${prefix}_assignment_projection_outbox`,
      `${prefix}_assignment_delete_projection_outbox`,
      `${prefix}_preference_projection_outbox`,
      `${prefix}_entitlement_projection_outbox`,
      `${prefix}_scope_projection_outbox`,
      `${prefix}_policy_projection_outbox`,
    ];
    const triggers = await pool.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname=ANY($1::text[])
      ORDER BY tgname
    `, [expectedTriggers]);
    expect(triggers.rows.map(row => row.tgname)).toEqual([...expectedTriggers].sort());

    await pool.query(`
      INSERT INTO ${prefix}_tenant_memberships
        (tenant_id,user_id,persona,is_owner,status,source,version,created_by,updated_by)
      VALUES ('tenant-a','user-a','org_admin',TRUE,'active','governance',1,'admin','admin');

      INSERT INTO ${prefix}_platform_admins
        (user_id,status,source,version,created_by,updated_by)
      VALUES ('platform-user','active','governance',1,'admin','admin');

      INSERT INTO ${prefix}_resource_assignment_sets
        (tenant_id,resource_type,resource_id,source,version,created_by,updated_by)
      VALUES ('tenant-a','skill','skill-a','governance',1,'admin','admin');

      INSERT INTO ${prefix}_resource_assignments
        (assignment_id,tenant_id,resource_type,resource_id,assignee_type,assignee_id,effect,origin,version,created_by,updated_by)
      VALUES ('assignment-a','tenant-a','skill','skill-a','user','user-a','allow','direct',1,'admin','admin');
      DELETE FROM ${prefix}_resource_assignments WHERE assignment_id='assignment-a';

      INSERT INTO ${prefix}_user_resource_preferences
        (user_id,resource_type,resource_id,enabled,source,version)
      VALUES ('user-a','skill','skill-a',TRUE,'user',1);

      INSERT INTO ${prefix}_tenant_entitlement_sets
        (tenant_id,source,status,version,created_by,updated_by,update_reason)
      VALUES ('tenant-a','platform_override','active',1,'admin','admin','v17-test');

      INSERT INTO ${prefix}_entitlement_resource_scopes
        (tenant_id,resource_type,mode,source,version,created_by,updated_by)
      VALUES ('tenant-a','skill','all','governance',1,'admin','admin');

      INSERT INTO ${prefix}_tenant_policies
        (tenant_id,policy_key,value_json,source,version,created_by,updated_by)
      VALUES ('tenant-a','credential.require_approval','true'::jsonb,'governance',1,'admin','admin');
    `);

    const outbox = await pool.query<{ projector: string; count: string }>(`
      SELECT projector,count(*) AS count
      FROM ${prefix}_governance_projection_outbox
      GROUP BY projector ORDER BY projector
    `);
    expect(outbox.rows).toEqual([
      { projector: 'assignment', count: '2' },
      { projector: 'membership', count: '1' },
      { projector: 'platform_admin', count: '1' },
      { projector: 'preference', count: '1' },
      { projector: 'tenant_settings', count: '3' },
    ]);
  }, 60_000);
});
