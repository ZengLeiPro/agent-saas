import { describe, expect, it } from 'vitest';

import {
  governancePersonaForUser,
  isActivePlatformAdminIdentity,
} from '../governance/subject/platformIdentity.js';

describe('platform identity helpers', () => {
  it('平台管理员事实必须同时绑定 pantheon 租户与 active 状态', () => {
    expect(isActivePlatformAdminIdentity('pantheon', { status: 'active' })).toBe(true);
    expect(isActivePlatformAdminIdentity('customer-a', { status: 'active' })).toBe(false);
    expect(isActivePlatformAdminIdentity('pantheon', { status: 'disabled' })).toBe(false);
  });

  it('审计 Persona 同时依据角色和租户归类', () => {
    expect(governancePersonaForUser({ role: 'admin', tenantId: 'pantheon' })).toBe(
      'platform_admin',
    );
    expect(governancePersonaForUser({ role: 'admin', tenantId: 'customer-a' })).toBe('org_admin');
    expect(governancePersonaForUser({ role: 'user', tenantId: 'customer-a' })).toBe('member');
  });
});
