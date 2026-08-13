import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PgGovernanceMigrationRunner,
  type GovernancePgPool,
} from '../data/governance-schema/migrations.js';
import { PgOAuthGrantStore } from '../data/oauthGrants/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Governance Schema V19 PostgreSQL 升级、约束与事务回滚', () => {
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

  it('V17 中途失败回滚到 V16，重试升级到 V19 并建立 Agent DWS 账号约束与八类 outbox trigger', async () => {
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
      Array.from({ length: 19 }, (_, index) => index + 1),
    );
    const v18Tables = await pool.query<{ name: string | null }>(
      `SELECT to_regclass($1) AS name UNION ALL SELECT to_regclass($2) UNION ALL SELECT to_regclass($3) UNION ALL SELECT to_regclass($4)`,
      [`${prefix}_directory_groups`, `${prefix}_directory_group_members`, `${prefix}_oauth_grants`, `${prefix}_oauth_approval_records`],
    );
    expect(v18Tables.rows.map(row => row.name)).toEqual([
      `${prefix}_directory_groups`, `${prefix}_directory_group_members`, `${prefix}_oauth_grants`, `${prefix}_oauth_approval_records`,
    ]);
    const v19Table = await pool.query<{ name: string | null }>(`SELECT to_regclass($1) AS name`, [`${prefix}_agent_dws_accounts`]);
    expect(v19Table.rows[0]?.name).toBe(`${prefix}_agent_dws_accounts`);
    await pool.query(`INSERT INTO ${prefix}_managed_agents
      (agent_id,tenant_id,kind,owner_user_id,status,revision,created_by,updated_by)
      VALUES ('oa-sales','tenant-a','org_agent','admin','enabled',1,'admin','admin')`);
    await pool.query(`INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,status,event_policy_json,created_by,updated_by)
      VALUES ('adws-a','tenant-a','oa-sales','销售数字员工','sales-agent-001','draft','{"kinds":["at_me","all_direct"]}'::jsonb,'admin','admin')`);
    await expect(pool.query(`INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,status,event_policy_json,created_by,updated_by)
      VALUES ('adws-b','tenant-b','oa-sales','越权账号','cross-tenant','draft','{"kinds":["at_me"]}'::jsonb,'admin','admin')`)).rejects.toThrow();
    await expect(pool.query(`INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,status,event_policy_json,created_by,updated_by)
      VALUES ('adws-c','tenant-a','oa-sales','坏事件范围','bad-events','draft','{"kinds":["unknown"]}'::jsonb,'admin','admin')`)).rejects.toThrow();
    await pool.query(`INSERT INTO ${prefix}_directory_groups (group_id,tenant_id,source,display_name,status) VALUES ('g-a','tenant-a','governance','A','active')`);
    await expect(pool.query(`INSERT INTO ${prefix}_directory_group_members (tenant_id,group_id,user_id,source) VALUES ('tenant-b','g-a','user-a','governance')`)).rejects.toThrow();
    await pool.query(`INSERT INTO ${prefix}_tenant_memberships
      (tenant_id,user_id,persona,is_owner,status,source,version,created_by,updated_by)
      VALUES ('tenant-a','user-a','org_admin',TRUE,'active','governance',1,'admin','admin')`);
    await pool.query(`INSERT INTO ${prefix}_oauth_grants (grant_id,tenant_id,subject_user_id,provider,status,approved_at) VALUES ('grant-a','tenant-a','user-a','google','active',NOW())`);
    await expect(pool.query(`INSERT INTO ${prefix}_oauth_approval_records (approval_id,grant_id,tenant_id,subject_user_id,action,purpose,actor_user_id) VALUES ('approval-bad','grant-a','tenant-b','user-a','approved','test','user-a')`)).rejects.toThrow();

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

  it('V18 的 Directory Group 硬约束拒绝 self、2 节点、长环及绕 store 原始写入', async () => {
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    const groups = `${prefix}_directory_groups`;
    await pool.query(`INSERT INTO ${groups} (group_id,tenant_id,source,display_name,status) VALUES
      ('cycle-self','cycle-tenant','governance','Self','active'),
      ('cycle-2a','cycle-tenant','governance','2A','active'),
      ('cycle-2b','cycle-tenant','governance','2B','active'),
      ('cycle-la','cycle-tenant','governance','LA','active'),
      ('cycle-lb','cycle-tenant','governance','LB','active'),
      ('cycle-lc','cycle-tenant','governance','LC','active'),
      ('cycle-ld','cycle-tenant','governance','LD','active')`);

    await expect(pool.query(`UPDATE ${groups} SET parent_group_id='cycle-self' WHERE group_id='cycle-self'`))
      .rejects.toThrow();

    const expectDeferredCycle = async (updates: string[]) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const update of updates) await client.query(update);
        await expect(client.query('COMMIT')).rejects.toThrow('DIRECTORY_GROUP_CYCLE');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    await expectDeferredCycle([
      `UPDATE ${groups} SET parent_group_id='cycle-2b' WHERE group_id='cycle-2a'`,
      `UPDATE ${groups} SET parent_group_id='cycle-2a' WHERE group_id='cycle-2b'`,
    ]);
    await expectDeferredCycle([
      `UPDATE ${groups} SET parent_group_id='cycle-lb' WHERE group_id='cycle-la'`,
      `UPDATE ${groups} SET parent_group_id='cycle-lc' WHERE group_id='cycle-lb'`,
      `UPDATE ${groups} SET parent_group_id='cycle-ld' WHERE group_id='cycle-lc'`,
      `UPDATE ${groups} SET parent_group_id='cycle-la' WHERE group_id='cycle-ld'`,
    ]);
    await expect(pool.query(`INSERT INTO ${groups}
      (group_id,tenant_id,source,display_name,parent_group_id,status) VALUES
      ('raw-a','raw-tenant','governance','A','raw-b','active'),
      ('raw-b','raw-tenant','governance','B','raw-c','active'),
      ('raw-c','raw-tenant','governance','C','raw-a','active')`))
      .rejects.toThrow('DIRECTORY_GROUP_CYCLE');
  }, 30_000);

  it('V18 partial unique 在顺序与并发原始写入下只允许一个同目标活动 Job', async () => {
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    const jobs = `${prefix}_governance_change_jobs`;
    const insert = (jobId: string, key: string, targetId: string) => pool.query(`INSERT INTO ${jobs}
      (job_id,tenant_id,job_type,target_type,target_id,idempotency_key,status,created_by,updated_by)
      VALUES ($1,'job-tenant','tenant_delete','tenant',$3,$2,'pending','tester','tester')`,
    [jobId, key, targetId]);
    await insert('job-seq-1', 'seq-1', 'seq-target');
    await expect(insert('job-seq-2', 'seq-2', 'seq-target')).rejects.toThrow();
    await pool.query(`UPDATE ${jobs} SET status='failed' WHERE job_id='job-seq-1'`);
    await expect(insert('job-seq-2', 'seq-2', 'seq-target')).resolves.toMatchObject({ rowCount: 1 });

    const concurrent = await Promise.allSettled([
      insert('job-race-1', 'race-1', 'race-target'),
      insert('job-race-2', 'race-2', 'race-target'),
    ]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);
  }, 30_000);

  it('V18 中途失败时整版回滚到 V17，重试后幂等成功', async () => {
    const v18Prefix = `${prefix}_v18rb`;
    let injected = false;
    const failingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: readonly unknown[]) => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            if (!injected && normalized.includes(`${v18Prefix}_oauth_approval_records`)) {
              injected = true;
              throw new Error('INJECTED_V18_FAILURE');
            }
            return client.query(text, values as never);
          },
          release: () => client.release(),
        };
      },
    } as unknown as GovernancePgPool;
    await expect(new PgGovernanceMigrationRunner(failingPool, v18Prefix).run())
      .rejects.toThrow('INJECTED_V18_FAILURE');
    const version = await pool.query<{ version: number }>(
      `SELECT MAX(version) AS version FROM ${v18Prefix}_governance_schema_versions`,
    );
    expect(Number(version.rows[0]?.version)).toBe(17);
    const v18Tables = await pool.query<{ directory: string | null; oauth: string | null }>(
      'SELECT to_regclass($1) AS directory, to_regclass($2) AS oauth',
      [`${v18Prefix}_directory_groups`, `${v18Prefix}_oauth_grants`],
    );
    expect(v18Tables.rows[0]).toEqual({ directory: null, oauth: null });
    const jobs = `${v18Prefix}_governance_change_jobs`;
    const jobDomains = `${v18Prefix}_governance_change_job_domains`;
    const assignments = `${v18Prefix}_resource_assignments`;
    const assignmentSets = `${v18Prefix}_resource_assignment_sets`;
    const unresolvedBefore = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name=$1 AND column_name='unresolved_items_json'
    `, [jobDomains]);
    expect(Number(unresolvedBefore.rows[0]?.count)).toBe(0);
    await expect(pool.query(`INSERT INTO ${jobs}
      (job_id,tenant_id,job_type,target_type,target_id,idempotency_key,status,created_by,updated_by)
      VALUES ('rollback-partial','rb','tenant_delete','tenant','rb','rollback-partial','partial','tester','tester')`))
      .rejects.toThrow();
    await pool.query(`INSERT INTO ${assignmentSets}
      (tenant_id,resource_type,resource_id,source,created_by,updated_by)
      VALUES ('rb','connector','connector-1','governance','tester','tester')`);
    await expect(pool.query(`INSERT INTO ${assignments}
      (assignment_id,tenant_id,resource_type,resource_id,assignee_type,effect,origin,created_by,updated_by)
      VALUES ('rollback-connector','rb','connector','connector-1','everyone','allow','direct','tester','tester')`))
      .rejects.toThrow();
    const runner = new PgGovernanceMigrationRunner(pool, v18Prefix);
    await runner.run();
    await runner.run();
    const retried = await pool.query<{ version: number }>(
      `SELECT MAX(version) AS version FROM ${v18Prefix}_governance_schema_versions`,
    );
    expect(Number(retried.rows[0]?.version)).toBe(18);
    const unresolvedAfter = await pool.query<{ is_nullable: string; column_default: string }>(`
      SELECT is_nullable,column_default FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name=$1 AND column_name='unresolved_items_json'
    `, [jobDomains]);
    expect(unresolvedAfter.rows[0]?.is_nullable).toBe('NO');
    expect(unresolvedAfter.rows[0]?.column_default).toContain('[]');
    await expect(pool.query(`INSERT INTO ${jobs}
      (job_id,tenant_id,job_type,target_type,target_id,idempotency_key,status,created_by,updated_by)
      VALUES ('success-partial','rb','tenant_delete','tenant','rb','success-partial','partial','tester','tester')`))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(`INSERT INTO ${assignments}
      (assignment_id,tenant_id,resource_type,resource_id,assignee_type,effect,origin,created_by,updated_by)
      VALUES ('success-connector','rb','connector','connector-1','everyone','allow','direct','tester','tester')`))
      .resolves.toMatchObject({ rowCount: 1 });
    await pool.query(`INSERT INTO ${assignmentSets}
      (tenant_id,resource_type,resource_id,source,created_by,updated_by)
      VALUES ('rb','unknown','unknown-1','governance','tester','tester')`);
    await expect(pool.query(`INSERT INTO ${assignments}
      (assignment_id,tenant_id,resource_type,resource_id,assignee_type,effect,origin,created_by,updated_by)
      VALUES ('unknown-type','rb','unknown','unknown-1','everyone','allow','direct','tester','tester')`))
      .rejects.toThrow();
    const assignmentChecks = await pool.query<{ count: string; definitions: string[] }>(`
      SELECT COUNT(*)::text AS count,ARRAY_AGG(pg_get_constraintdef(oid) ORDER BY conname) AS definitions
      FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%resource_type%'
    `, [assignments]);
    expect(Number(assignmentChecks.rows[0]?.count)).toBe(1);
    expect(assignmentChecks.rows[0]?.definitions.join(' ')).toContain('connector');
  });

  it('原生 OAuth handoff 仅保存 hash，并发兑换同一短码时恰好一次成功', async () => {
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    await pool.query(`
      INSERT INTO ${prefix}_tenant_memberships
        (tenant_id,user_id,persona,is_owner,status,source,version,created_by,updated_by)
      VALUES ('tenant-native','user-native','member',FALSE,'active','governance',1,'admin','admin')
      ON CONFLICT (tenant_id,user_id) DO NOTHING
    `);
    const grants = new PgOAuthGrantStore({ pool, tablePrefix: prefix });
    await grants.beginNativeHandoff({
      providerState: 'provider-state-native', userId: 'user-native', tenantId: 'tenant-native',
      connectorId: 'google-workspace', deviceId: 'device-native-1',
    });
    const code = await grants.completeNativeHandoff({ providerState: 'provider-state-native', status: 'succeeded' });
    expect(code).toHaveLength(48);
    const stored = await pool.query<{ provider_state_hash: string; code_hash: string }>(
      `SELECT provider_state_hash,code_hash FROM ${prefix}_native_oauth_handoffs WHERE tenant_id='tenant-native'`,
    );
    expect(JSON.stringify(stored.rows)).not.toContain('provider-state-native');
    expect(JSON.stringify(stored.rows)).not.toContain(code);
    await expect(grants.completeNativeHandoff({ providerState: 'provider-state-native', status: 'failed', errorCode: 'REPLAY' }))
      .resolves.toBeNull();
    await expect(grants.consumeNativeHandoff({
      code: code!, userId: 'wrong-user', tenantId: 'tenant-native', deviceId: 'device-native-1',
    })).resolves.toBeNull();
    await expect(grants.consumeNativeHandoff({
      code: code!, userId: 'user-native', tenantId: 'wrong-tenant', deviceId: 'device-native-1',
    })).resolves.toBeNull();
    await expect(grants.consumeNativeHandoff({
      code: code!, userId: 'user-native', tenantId: 'tenant-native', deviceId: 'wrong-device',
    })).resolves.toBeNull();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => grants.consumeNativeHandoff({
      code: code!, userId: 'user-native', tenantId: 'tenant-native', deviceId: 'device-native-1',
    })));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(attempts.find(Boolean)).toMatchObject({ connectorId: 'google-workspace', status: 'succeeded' });

    await grants.beginNativeHandoff({
      providerState: 'provider-state-expired', userId: 'user-native', tenantId: 'tenant-native',
      connectorId: 'google-workspace', deviceId: 'device-native-1',
    });
    const expiredCode = await grants.completeNativeHandoff({ providerState: 'provider-state-expired', status: 'succeeded' });
    await pool.query(`UPDATE ${prefix}_native_oauth_handoffs SET code_expires_at=NOW()-INTERVAL '1 second'
      WHERE tenant_id='tenant-native' AND connector_id='google-workspace'`);
    await expect(grants.consumeNativeHandoff({
      code: expiredCode!, userId: 'user-native', tenantId: 'tenant-native', deviceId: 'device-native-1',
    })).resolves.toBeNull();
  });

});
