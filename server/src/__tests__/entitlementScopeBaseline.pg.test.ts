import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ENTITLEMENT_RESOURCE_TYPES, PgEntitlementStore } from '../data/entitlements/index.js';
import { DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Entitlement 资源范围基线 PostgreSQL 合约', () => {
  const prefix = `scopebase_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgEntitlementStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, max: 2 });
    store = new PgEntitlementStore({ pool, tablePrefix: prefix, platformTenantId: 'pantheon' });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    const tables = await pool.query<{ tablename: string }>(
      `
      SELECT tablename FROM pg_tables
      WHERE schemaname=current_schema() AND LEFT(tablename,LENGTH($1))=$1
    `,
      [prefix],
    );
    for (const row of tables.rows)
      await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    const functions = await pool.query<{ proname: string; args: string }>(
      `
      SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND LEFT(p.proname,LENGTH($1))=$1
    `,
      [prefix],
    );
    for (const row of functions.rows)
      await pool.query(`DROP FUNCTION IF EXISTS "${row.proname}"(${row.args}) CASCADE`);
    await pool.end();
  }, 30_000);

  it('新组织初始化六类 v1 基线，新增三类为空 selected，业务系统不投影组织范围', async () => {
    await store.provisionTenantGovernance({
      tenantId: 'tenant-new',
      settings: DEFAULT_TENANT_SETTINGS,
      createdBy: 'platform-1',
    });
    const scopes = await store.listResourceScopes('tenant-new');
    expect(scopes.map((item) => item.resourceType)).toEqual(
      [...ENTITLEMENT_RESOURCE_TYPES].filter((type) => type !== 'integrated_system').sort(),
    );
    expect(scopes.every((item) => item.version === 1)).toBe(true);
    for (const resourceType of ['agent_template', 'skill', 'environment_template']) {
      expect(scopes.find((item) => item.resourceType === resourceType)).toMatchObject({
        mode: 'selected',
        resourceIds: [],
        source: 'governance',
      });
    }
    await store.deleteTenantGovernance('tenant-new');
    await expect(store.getEntitlementSet('tenant-new')).resolves.toBeNull();
    await expect(store.listResourceScopes('tenant-new')).resolves.toEqual([]);
  });

  it('存量回填不覆盖治理行且第二次执行为零变更', async () => {
    await store.provisionTenantGovernance({
      tenantId: 'tenant-old',
      settings: DEFAULT_TENANT_SETTINGS,
      createdBy: 'platform-1',
    });
    await pool.query(`DELETE FROM ${store.scopesTable}
      WHERE tenant_id='tenant-old' AND resource_type IN ('skill','environment_template')`);
    await pool.query(`UPDATE ${store.scopesTable}
      SET version=7,source='governance' WHERE tenant_id='tenant-old' AND resource_type='model'`);
    const input = {
      tenants: [{ id: 'tenant-old', settings: DEFAULT_TENANT_SETTINGS }],
      platformTenantId: 'pantheon',
      createdBy: 'system:scope-baseline',
    };
    await expect(store.backfillMissingResourceScopes(input)).resolves.toMatchObject({
      scopesInserted: 2,
      scopesSkipped: ENTITLEMENT_RESOURCE_TYPES.filter((type) => type !== 'integrated_system').length - 2,
      tenantsWithErrors: 0,
    });
    await expect(store.backfillMissingResourceScopes(input)).resolves.toMatchObject({
      scopesInserted: 0,
      scopesSkipped: ENTITLEMENT_RESOURCE_TYPES.filter((type) => type !== 'integrated_system').length,
      tenantsWithErrors: 0,
    });
    expect(
      (await store.listResourceScopes('tenant-old')).find((item) => item.resourceType === 'model'),
    ).toMatchObject({ version: 7, source: 'governance' });
  });

  it('历史业务系统范围原样保留，但不参与六类范围回填与计数', async () => {
    const tenantId = 'tenant-legacy-system';
    await store.provisionTenantGovernance({
      tenantId, settings: DEFAULT_TENANT_SETTINGS, createdBy: 'fixture',
    });
    // 历史数据只能由测试夹具构造，不能借用已经退役的治理 HTTP 写入口。
    await pool.query(`INSERT INTO ${store.scopesTable}
      (tenant_id,resource_type,mode,source,version,created_by,updated_by)
      VALUES ($1,'integrated_system','selected','governance',7,'legacy','legacy')`, [tenantId]);
    await pool.query(`INSERT INTO ${store.itemsTable}
      (tenant_id,resource_type,resource_id,source,created_by)
      VALUES ($1,'integrated_system','legacy-only','governance','legacy')`, [tenantId]);
    const before = (await store.listResourceScopes(tenantId)).find(
      (scope) => scope.resourceType === 'integrated_system',
    );
    await pool.query(`DELETE FROM ${store.scopesTable}
      WHERE tenant_id=$1 AND resource_type='skill'`, [tenantId]);
    const input = {
      tenants: [{ id: tenantId, settings: DEFAULT_TENANT_SETTINGS }],
      platformTenantId: 'pantheon', createdBy: 'fixture',
    };
    await expect(store.backfillMissingResourceScopes(input)).resolves.toMatchObject({
      scopesInserted: 1, scopesSkipped: 5, tenantsWithErrors: 0,
    });
    await expect(store.backfillMissingResourceScopes(input)).resolves.toMatchObject({
      scopesInserted: 0, scopesSkipped: 6, tenantsWithErrors: 0,
    });
    expect((await store.listResourceScopes(tenantId)).find(
      (scope) => scope.resourceType === 'integrated_system',
    )).toEqual(before);
  });

});
