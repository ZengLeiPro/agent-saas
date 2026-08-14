import { describe, expect, it } from 'vitest';

import { PgMembershipStore } from '../data/memberships/index.js';

const NOW = '2026-08-08T00:00:00.000Z';

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'acme',
    user_id: 'user-owner',
    persona: 'org_admin',
    is_owner: true,
    status: 'active',
    source: 'governance',
    version: '3',
    created_at: NOW,
    created_by: 'system',
    updated_at: NOW,
    updated_by: 'system',
    ...overrides,
  };
}

describe('Membership/Owner 治理事实模型', () => {
  it('有序 migration 在 advisory lock 下创建 Membership、PlatformAdmin 与 migration issue 表', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgMembershipStore({ pool: pool as never, tablePrefix: 'test' });

    await store.init();

    const sql = queries.map(item => item.sql).join('\n');
    expect(sql).toContain('pg_advisory_lock');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_tenant_memberships');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_platform_admins');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governance_migration_issues');
    expect(sql).toContain("CHECK (NOT is_owner OR persona = 'org_admin')");
    expect(queries.filter(item => item.sql === 'BEGIN')).toHaveLength(21);
    expect(queries.filter(item => item.sql === 'COMMIT')).toHaveLength(21);
  });

  it('legacy backfill 把 pantheon admin 与客户 Membership 分离；唯一 active admin 确定为 Owner，多 admin 只记问题不猜', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes("persona = 'org_admin' AND is_owner = TRUE")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('RETURNING *') && sql.includes('governance_migration_issues')) {
        return {
          rows: [{
            issue_id: 'issue-1',
            issue_type: params?.[1],
            tenant_id: params?.[2],
            resource_type: params?.[3],
            resource_id: params?.[4],
            legacy_key: params?.[5],
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
    const store = new PgMembershipStore({ pool: pool as never, tablePrefix: 'test' });

    const result = await store.backfillLegacyIdentities({
      platformTenantId: 'pantheon',
      projectedBy: 'system:governance-m1',
      tenants: [{ id: 'pantheon' }, { id: 'acme' }, { id: 'beta' }],
      users: [
        { id: 'platform-1', role: 'admin', tenantId: 'pantheon' },
        { id: 'acme-owner', role: 'admin', tenantId: 'acme' },
        { id: 'acme-member', role: 'user', tenantId: 'acme' },
        { id: 'beta-admin-1', role: 'admin', tenantId: 'beta' },
        { id: 'beta-admin-2', role: 'admin', tenantId: 'beta' },
      ],
    });

    expect(result).toEqual({
      membershipsProjected: 4,
      platformAdminsProjected: 1,
      issuesRecorded: 1,
    });
    expect(queries.some(item =>
      item.sql.includes('INSERT INTO test_platform_admins') && item.params?.[0] === 'platform-1',
    )).toBe(true);
    expect(queries.some(item =>
      item.sql.includes('UPDATE test_tenant_memberships') && item.params?.[1] === 'acme-owner',
    )).toBe(true);
    expect(queries.some(item =>
      item.sql.includes('test_governance_migration_issues') && item.params?.[1] === 'owner_migration_pending',
    )).toBe(true);
    expect(queries.some(item =>
      item.sql.includes('UPDATE test_tenant_memberships') && item.params?.[1] === 'beta-admin-1',
    )).toBe(false);
  });

  it('撤销最后有效 Owner 时在事务锁内稳定拒绝', async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT * FROM test_tenant_memberships')) {
        return { rows: [membershipRow()], rowCount: 1 };
      }
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgMembershipStore({ pool: pool as never, tablePrefix: 'test' });

    await expect(store.updateMembershipIdentity('acme', 'user-owner', {
      isOwner: false,
      expectedVersion: 3,
      updatedBy: 'user-owner',
      authorization: { kind: 'tenant_member', actorTenantId: 'acme' },
    })).rejects.toMatchObject({
      code: 'LAST_EFFECTIVE_OWNER_PROTECTED',
    });

    expect(queries.some(sql => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(queries.some(sql => sql.includes('FOR UPDATE'))).toBe(true);
    expect(queries).toContain('ROLLBACK');
    expect(queries.some(sql => sql.includes('UPDATE test_tenant_memberships'))).toBe(false);
  });

  it('事务内拒绝普通 org_admin 修改同级管理员状态', async () => {
    const queries: string[] = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      if (sql.includes('SELECT * FROM test_tenant_memberships')) {
        if (params?.[1] === 'admin-1') {
          return { rows: [membershipRow({ user_id: 'admin-1', is_owner: false })], rowCount: 1 };
        }
        return { rows: [membershipRow({ user_id: 'admin-2', is_owner: false })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgMembershipStore({ pool: pool as never, tablePrefix: 'test' });

    await expect(store.updateMembershipIdentity('acme', 'admin-2', {
      status: 'disabled',
      expectedVersion: 3,
      updatedBy: 'admin-1',
      authorization: { kind: 'tenant_member', actorTenantId: 'acme' },
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_CHANGE_FORBIDDEN' });

    expect(queries).toContain('ROLLBACK');
    expect(queries.some(sql => sql.includes('UPDATE test_tenant_memberships'))).toBe(false);
  });

  it('禁用最后一名平台管理员时稳定拒绝', async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT * FROM test_platform_admins')) {
        return {
          rows: [{
            user_id: 'platform-1',
            status: 'active',
            source: 'governance',
            version: 2,
            created_at: NOW,
            created_by: 'system',
            updated_at: NOW,
            updated_by: 'system',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgMembershipStore({ pool: pool as never, tablePrefix: 'test' });

    await expect(store.updatePlatformAdmin('platform-1', {
      status: 'disabled',
      expectedVersion: 2,
      updatedBy: 'platform-1',
    })).rejects.toMatchObject({ code: 'LAST_PLATFORM_ADMIN_PROTECTED' });

    expect(queries).toContain('ROLLBACK');
    expect(queries.some(sql => sql.includes('UPDATE test_platform_admins'))).toBe(false);
  });

  it('有另一名有效 Owner 时允许降级，并用 expectedVersion 防并发覆盖', async () => {
    const query = async (sql: string) => {
      if (sql.includes('SELECT * FROM test_tenant_memberships')) {
        return { rows: [membershipRow()], rowCount: 1 };
      }
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: 1 }], rowCount: 1 };
      if (sql.includes('UPDATE test_tenant_memberships')) {
        return {
          rows: [membershipRow({ is_owner: false, version: '4', updated_by: 'platform-1' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgMembershipStore({ pool: pool as never, tablePrefix: 'test' });

    const updated = await store.updateMembershipIdentity('acme', 'user-owner', {
      isOwner: false,
      expectedVersion: 3,
      updatedBy: 'user-owner',
      authorization: { kind: 'tenant_member', actorTenantId: 'acme' },
    });
    expect(updated).toMatchObject({ isOwner: false, version: 4, source: 'governance' });
  });
});
