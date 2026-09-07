import { describe, expect, it } from 'vitest';
import type { PgEntitlementStore } from '../../data/entitlements/store.js';
import { MEMBER, ORG_ADMIN, PLATFORM_ADMIN, TEST_TENANT } from '../__tests__/harness.js';
import { installableScope, installationActions, managementTenant } from './managementPolicy.js';

describe('业务系统管理权限', () => {
  it('平台可跨组织、组织只能本组织、成员拒绝', () => {
    expect(managementTenant(PLATFORM_ADMIN, 'other')).toBe('other');
    expect(managementTenant(ORG_ADMIN)).toBe(TEST_TENANT);
    expect(() => managementTenant(ORG_ADMIN, 'other')).toThrow();
    expect(() => managementTenant(MEMBER)).toThrow();
    expect(() => managementTenant(undefined)).toThrow();
  });
  it.each([
    ['active', 'all', [], true],
    ['active', 'selected', ['demo'], true],
    ['active', 'selected', [], false],
    ['suspended', 'all', [], false],
    ['expired', 'all', [], false],
  ])('权益 %s / %s / %j', async (status, mode, resourceIds, expected) => {
    const store = {
      getEntitlementSet: async () => ({ status }),
      listResourceScopes: async () => [{ resourceType: 'integrated_system', mode, resourceIds }],
    } as unknown as PgEntitlementStore;
    expect((await installableScope(store, TEST_TENANT))('demo')).toBe(expected);
  });
  it('依赖不可用、过期、空权益均拒绝', async () => {
    await expect(installableScope(undefined, TEST_TENANT)).rejects.toThrow();
    for (const set of [
      null,
      { status: 'active', effectiveTo: '2000-01-01' },
      { status: 'active', effectiveFrom: 'invalid' },
    ]) {
      const store = {
        getEntitlementSet: async () => set,
        listResourceScopes: async () => [{ resourceType: 'integrated_system', mode: 'all' }],
      } as unknown as PgEntitlementStore;
      expect((await installableScope(store, TEST_TENANT))('demo')).toBe(false);
    }
  });
  it('动作不向成员和其他组织泄露，删除终态无动作', () => {
    const installation = { status: 'enabled' as const, tenantId: TEST_TENANT };
    expect(installationActions(MEMBER, installation)).toEqual([]);
    expect(installationActions(ORG_ADMIN, { ...installation, tenantId: 'other' })).toEqual([]);
    expect(installationActions(PLATFORM_ADMIN, { ...installation, status: 'deleted' })).toEqual([]);
    expect(installationActions(ORG_ADMIN, installation)).toContain('edit_assignments');
    expect(installationActions(ORG_ADMIN, installation)).not.toContain('issue_credential');
  });
});
