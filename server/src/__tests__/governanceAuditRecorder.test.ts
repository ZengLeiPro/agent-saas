import { describe, expect, it, vi } from 'vitest';

import { recordGovernanceIntent } from '../data/governance-audit/recorder.js';

describe('governance audit recorder identity', () => {
  it('按 actor 的角色与租户记录平台管理员、组织管理员和普通成员', async () => {
    const append = vi.fn(async (input) => ({
      ...input,
      auditId: `audit-${append.mock.calls.length}`,
    }));
    const store = { append } as never;
    const change = {
      action: 'test.change',
      targetType: 'test',
      targetId: 'target-1',
      purpose: 'identity regression',
    };

    await recordGovernanceIntent(
      store,
      { sub: 'platform-1', role: 'admin', tenantId: 'pantheon' },
      change,
    );
    await recordGovernanceIntent(
      store,
      { sub: 'org-admin-1', role: 'admin', tenantId: 'tenant-a' },
      change,
    );
    await recordGovernanceIntent(
      store,
      { sub: 'member-1', role: 'user', tenantId: 'tenant-a' },
      change,
    );

    expect(append.mock.calls.map(([event]) => event.actorPersona)).toEqual([
      'platform_admin',
      'org_admin',
      'member',
    ]);
  });
});
