import { describe, expect, it } from 'vitest';

import type { TenantMembership } from '../data/memberships/index.js';
import { platformMembershipActions } from './governancePlatformMembership.js';

const member = (overrides: Partial<TenantMembership> = {}): TenantMembership => ({
  tenantId: 'tenant-a',
  userId: 'owner-1',
  persona: 'org_admin',
  isOwner: true,
  status: 'active',
  source: 'governance',
  version: 1,
  createdAt: '2026-09-04T00:00:00.000Z',
  createdBy: 'system',
  updatedAt: '2026-09-04T00:00:00.000Z',
  updatedBy: 'system',
  ...overrides,
});

describe('platformMembershipActions', () => {
  it('平台管理员对有效 Owner 获得与写端一致且要求原因的管理动作', () => {
    const actions = platformMembershipActions('pantheon', 'tenant-a', member());
    expect(actions.map((action) => action.id)).toEqual([
      'revoke_owner',
      'demote_member',
      'disable',
    ]);
    expect(actions.every((action) => action.requiresReason)).toBe(true);
  });

  it('平台自身租户不暴露组织成员管理动作', () => {
    expect(
      platformMembershipActions('pantheon', 'pantheon', member({ tenantId: 'pantheon' })),
    ).toEqual([]);
  });
});
