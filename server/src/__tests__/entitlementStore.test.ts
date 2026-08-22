import { describe, expect, it } from 'vitest';

import { PgEntitlementStore } from '../data/entitlements/index.js';
import { DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';

const NOW = '2026-08-08T00:00:00.000Z';

function scopeRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'acme',
    resource_type: 'model',
    mode: 'selected',
    source: 'legacy_projection',
    version: 2,
    created_at: NOW,
    created_by: 'system',
    updated_at: NOW,
    updated_by: 'system',
    ...overrides,
  };
}

describe('Entitlement 与 Tenant Policy 独立事实模型', () => {
  it('migration 创建 EntitlementSet、Resource Scope/Item 与类型化 Policy 表', async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgEntitlementStore({ pool: pool as never, tablePrefix: 'test' });

    await store.init();

    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_tenant_entitlement_sets');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_entitlement_resource_scopes');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_entitlement_resource_items');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_tenant_policies');
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(24);
  });

  it('pantheon 不进入客户 Entitlement/Policy API', async () => {
    let queryCount = 0;
    const query = async () => {
      queryCount += 1;
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgEntitlementStore({
      pool: pool as never,
      tablePrefix: 'test',
      platformTenantId: 'pantheon',
    });

    await expect(store.getEntitlementSet('pantheon')).rejects.toMatchObject({
      code: 'PLATFORM_TENANT_GOVERNANCE_FORBIDDEN',
    });
    expect(queryCount).toBe(0);
  });

  it('legacy TenantSettings 同时投影硬权益与组织策略，并记录待双方确认问题', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes('SELECT * FROM test_entitlement_resource_scopes')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('test_tenant_policies') && sql.includes('RETURNING 1')) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (sql.includes('test_governance_migration_issues') && sql.includes('RETURNING *')) {
        return {
          rows: [{
            issue_id: 'issue-1',
            issue_type: params?.[1],
            tenant_id: params?.[2],
            resource_type: params?.[3],
            resource_id: params?.[4],
            detail_json: JSON.parse(String(params?.[6] ?? '{}')),
            status: 'open',
            version: 1,
            created_at: NOW,
            created_by: params?.[7],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgEntitlementStore({ pool: pool as never, tablePrefix: 'test' });
    const settings = structuredClone(DEFAULT_TENANT_SETTINGS);
    settings.features.imageGenEnabled = true;
    settings.features.cronEnabled = false;
    settings.features.debugModeAllowed = true;
    settings.features.debugModeEnabled = false;
    settings.quotas.maxUsers = 25;
    settings.models.allowedModels = ['group/model-b', 'group/model-a'];

    const result = await store.backfillLegacySettings({
      platformTenantId: 'pantheon',
      projectedBy: 'system:governance-m1',
      tenants: [
        { id: 'pantheon', settings: DEFAULT_TENANT_SETTINGS },
        { id: 'acme', settings },
      ],
    });

    expect(result).toEqual({
      tenantsProjected: 1,
      scopesProjected: 2,
      policiesProjected: 23,
      issuesRecorded: 1,
    });
    expect(queries.some(item =>
      item.sql.includes('test_tenant_entitlement_sets')
      && item.params?.[0] === 'acme'
      && JSON.parse(String(item.params?.[2])).maxUsers === 25,
    )).toBe(true);
    expect(queries.some(item =>
      item.sql.includes('INSERT INTO test_entitlement_resource_items')
      && item.params?.[1] === 'tool'
      && item.params?.[2] === 'image_gen',
    )).toBe(true);
    expect(queries.some(item =>
      item.sql.includes('INSERT INTO test_entitlement_resource_items')
      && item.params?.[1] === 'tool'
      && item.params?.[2] === 'cron',
    )).toBe(false);
    expect(queries.some(item =>
      item.sql.includes('test_tenant_policies')
      && item.params?.[1] === 'automation.cron.enabled'
      && item.params?.[2] === 'false',
    )).toBe(true);
    expect(queries.some(item =>
      item.sql.includes('test_tenant_policies')
      && item.params?.[1] === 'runtime.debug_mode.enabled'
      && item.params?.[2] === 'false',
    )).toBe(true);
    expect(queries.some(item =>
      item.sql.includes('test_governance_migration_issues')
      && item.params?.[1] === 'legacy_entitlement_policy_confirmation_required',
    )).toBe(true);
  });

  it('替换 Resource Scope 使用事务锁、expectedVersion，并原子替换 item', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes('SELECT * FROM test_entitlement_resource_scopes')) {
        return { rows: [scopeRow()], rowCount: 1 };
      }
      if (sql.includes('UPDATE test_entitlement_resource_scopes')) {
        return {
          rows: [scopeRow({ mode: 'selected', source: 'governance', version: 3, updated_by: 'platform-1' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgEntitlementStore({ pool: pool as never, tablePrefix: 'test' });

    const scope = await store.replaceResourceScope('acme', 'model', {
      mode: 'selected',
      resourceIds: ['group/model-b', 'group/model-a', 'group/model-a'],
      expectedVersion: 2,
      updatedBy: 'platform-1',
    });

    expect(scope).toMatchObject({
      source: 'governance',
      version: 3,
      resourceIds: ['group/model-a', 'group/model-b'],
    });
    expect(queries.some(item => item.sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(queries.some(item => item.sql.includes('FOR UPDATE'))).toBe(true);
    expect(queries.some(item => item.sql.includes('DELETE FROM test_entitlement_resource_items'))).toBe(true);
    expect(queries.filter(item => item.sql.includes('INSERT INTO test_entitlement_resource_items'))).toHaveLength(2);
  });
});
