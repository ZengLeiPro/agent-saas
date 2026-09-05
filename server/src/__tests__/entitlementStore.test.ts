import { describe, expect, it } from 'vitest';

import {
  ENTITLEMENT_RESOURCE_TYPES,
  PgEntitlementStore,
  TOOL_ENTITLEMENT_RESOURCE_IDS,
  normalizeLegacyEntitlementSettings,
} from '../data/entitlements/index.js';
import { GOVERNANCE_SCHEMA_VERSION } from '../data/governance-schema/migrations.js';
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
  it('migration 创建 EntitlementSet、Resource Scope/Item、Policy 并跑完当前 ledger', async () => {
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
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(GOVERNANCE_SCHEMA_VERSION);
  });

  it('legacy tool scope 与治理工具目录使用同一能力 ID 域', () => {
    const settings = structuredClone(DEFAULT_TENANT_SETTINGS);
    settings.features.filesEnabled = true;
    settings.features.cronEnabled = true;
    settings.features.mcpEnabled = true;
    settings.features.customSkillsEnabled = true;
    settings.features.personalAgentEnabled = true;
    settings.features.kbEnabled = true;
    settings.features.imageGenEnabled = true;
    settings.features.memoryPollingEnabled = true;
    settings.features.memoryConsolidationEnabled = true;
    settings.features.memoryWriteDelegationEnabled = true;

    const normalized = normalizeLegacyEntitlementSettings(settings) as {
      scopes: Array<{ resourceType: string; resourceIds: string[] }>;
    };
    const toolScope = normalized.scopes.find(scope => scope.resourceType === 'tool');

    expect(toolScope?.resourceIds).toEqual([...TOOL_ENTITLEMENT_RESOURCE_IDS].sort());
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
      scopesProjected: 3,
      policiesProjected: 23,
      issuesRecorded: 1,
    });
    expect(queries.some(item =>
      item.sql.includes('INSERT INTO test_entitlement_resource_scopes')
      && item.params?.[1] === 'connector'
      && item.params?.[2] === 'all',
    )).toBe(true);
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

  it('新组织一次事务初始化六类范围，新增三类使用 selected 空集合', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      return { rows: [], rowCount: 1 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgEntitlementStore({ pool: pool as never, tablePrefix: 'test' });

    await store.provisionTenantGovernance({
      tenantId: 'acme',
      settings: DEFAULT_TENANT_SETTINGS,
      createdBy: 'platform-1',
    });

    const scopeInserts = queries.filter(item => item.sql.includes('INSERT INTO test_entitlement_resource_scopes'));
    expect(scopeInserts.map(item => item.params?.[1])).toEqual(ENTITLEMENT_RESOURCE_TYPES);
    expect(scopeInserts.filter(item => ['agent_template', 'skill', 'environment_template', 'integrated_system'].includes(String(item.params?.[1]))))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ params: ['acme', 'agent_template', 'selected', 'platform-1'] }),
        expect.objectContaining({ params: ['acme', 'skill', 'selected', 'platform-1'] }),
        expect.objectContaining({ params: ['acme', 'environment_template', 'selected', 'platform-1'] }),
        expect.objectContaining({ params: ['acme', 'integrated_system', 'selected', 'platform-1'] }),
      ]));
    expect(queries.some(item => item.sql.includes("'tenant_provisioning'"))).toBe(true);
    expect(queries.filter(item => item.sql === 'BEGIN')).toHaveLength(1);
    expect(queries.filter(item => item.sql === 'COMMIT')).toHaveLength(1);
  });

  it('存量范围回填仅插入缺失类型，第二次执行零变更且不提高既有版本', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    let scan = 0;
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes('SELECT resource_type FROM test_entitlement_resource_scopes')) {
        scan += 1;
        const types = scan === 1 ? ['model', 'tool', 'connector'] : [...ENTITLEMENT_RESOURCE_TYPES];
        return { rows: types.map(resource_type => ({ resource_type })), rowCount: types.length };
      }
      if (sql.includes('INSERT INTO test_entitlement_resource_scopes')) {
        return { rows: [{ resource_type: params?.[1] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgEntitlementStore({ pool: pool as never, tablePrefix: 'test' });
    const input = {
      tenants: [{ id: 'pantheon' }, { id: 'acme', settings: DEFAULT_TENANT_SETTINGS }],
      platformTenantId: 'pantheon',
      createdBy: 'system:scope-baseline',
    };

    await expect(store.backfillMissingResourceScopes(input)).resolves.toEqual({
      tenantsScanned: 1,
      scopesInserted: ENTITLEMENT_RESOURCE_TYPES.length - 3,
      scopesSkipped: 3,
      tenantsWithErrors: 0,
      issuesRecorded: 0,
    });
    await expect(store.backfillMissingResourceScopes(input)).resolves.toEqual({
      tenantsScanned: 1,
      scopesInserted: 0,
      scopesSkipped: ENTITLEMENT_RESOURCE_TYPES.length,
      tenantsWithErrors: 0,
      issuesRecorded: 0,
    });
    const inserts = queries.filter(item => item.sql.includes('INSERT INTO test_entitlement_resource_scopes'));
    expect(inserts).toHaveLength(ENTITLEMENT_RESOURCE_TYPES.length - 3);
    expect(inserts.every(item => !item.sql.includes('DO UPDATE'))).toBe(true);
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
