import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgSkillGovernanceStore } from '../data/skillGovernance/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('技能治理删除后同包重导 PostgreSQL 合同', () => {
  const prefix = `skillgov_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgSkillGovernanceStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgSkillGovernanceStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

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
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=current_schema() AND LEFT(p.proname,LENGTH($1))=$1
      `, [prefix]);
      for (const row of functions.rows) {
        await pool.query(`DROP FUNCTION IF EXISTS "${row.proname}"(${row.args}) CASCADE`);
      }
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('连续两轮退役后原包重导保留 resourceId、递增版本并拒绝旧 revision 并发恢复', async () => {
    const definition = {
      name: 'sales-helper',
      description: '销售流程',
      legacySkillId: 'sales-helper',
      contentDigest: 'same-package',
      contentDigestAlgorithm: 'materialized-v2',
    };
    const first = await store.createAndPublishResource({
      skillId: 'personal-user-1-sales-helper', tenantId: 'tenant-a', scope: 'personal', ownerUserId: 'user-1',
      definition, createdBy: 'user-1',
    });
    const retired = await store.retire('tenant-a', first.resource.skillId, first.resource.revision, 'user-1');
    const second = await store.restoreAndPublishResource({
      tenantId: 'tenant-a', skillId: first.resource.skillId, scope: 'personal', ownerUserId: 'user-1',
      expectedRevision: retired.revision, definition, publishedBy: 'user-1',
    });
    const retiredAgain = await store.retire('tenant-a', first.resource.skillId, second.resource.revision, 'user-1');
    const restore = () => store.restoreAndPublishResource({
      tenantId: 'tenant-a', skillId: first.resource.skillId, scope: 'personal', ownerUserId: 'user-1',
      expectedRevision: retiredAgain.revision, definition, publishedBy: 'user-1',
    });
    const concurrent = await Promise.allSettled([restore(), restore()]);
    const fulfilled = concurrent.filter(result => result.status === 'fulfilled');
    const rejected = concurrent.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: 'SKILL_RESOURCE_VERSION_CONFLICT' } });

    const third = fulfilled[0]!.status === 'fulfilled' ? fulfilled[0].value : undefined;
    expect([first.resource.skillId, second.resource.skillId, third?.resource.skillId]).toEqual([
      'personal-user-1-sales-helper', 'personal-user-1-sales-helper', 'personal-user-1-sales-helper',
    ]);
    expect([first.version.versionNumber, second.version.versionNumber, third?.version.versionNumber]).toEqual([1, 2, 3]);
    const versions = await store.listVersions(first.resource.skillId);
    expect(versions.map(version => version.versionNumber)).toEqual([1, 2, 3]);
    expect(new Set(versions.map(version => version.digest)).size).toBe(3);
  });
});
