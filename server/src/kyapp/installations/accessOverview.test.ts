import { describe, expect, it, vi } from 'vitest';

import { InstallationAccessOverviewService } from './accessOverview.js';

describe('InstallationAccessOverviewService', () => {
  it('只返回最终生效的成员和 Agent，并汇总真实规则数量', async () => {
    const listEffectiveResourceIds = vi.fn(async (_tenantId, userId, _type, agentId) => {
      if (userId === 'u1')
        return [
          {
            resourceId: 'install-demo',
            bindingId: 'allow-group',
            assignmentVersion: 2,
            finalEffect: 'allow' as const,
            bindings: [
              {
                assignmentId: 'allow-group',
                assigneeType: 'directory_group' as const,
                assigneeId: 'sales',
                effect: 'allow' as const,
                origin: 'direct' as const,
              },
            ],
          },
        ];
      if (agentId === 'agent-1')
        return [
          {
            resourceId: 'install-demo',
            bindingId: 'allow-agent',
            assignmentVersion: 2,
            finalEffect: 'allow' as const,
            bindings: [
              {
                assignmentId: 'allow-agent',
                assigneeType: 'agent' as const,
                assigneeId: 'agent-1',
                effect: 'allow' as const,
                origin: 'direct' as const,
              },
            ],
          },
        ];
      return [];
    });
    const service = new InstallationAccessOverviewService({
      users: {
        listAll: () => [
          { id: 'u1', username: 'alice', realName: 'Alice', tenantId: 'tenant-a' },
          { id: 'u2', username: 'bob', tenantId: 'tenant-a' },
          { id: 'u3', username: 'disabled', tenantId: 'tenant-a', disabled: true },
        ],
      } as never,
      memberships: {
        listMemberships: async () => [
          { userId: 'u1', status: 'active' },
          { userId: 'u2', status: 'active' },
          { userId: 'u3', status: 'active' },
        ],
      } as never,
      assignments: { listEffectiveResourceIds } as never,
      assignmentSets: {
        getAssignmentSet: async () => ({ assignments: [{}, {}] }),
      } as never,
      groups: {
        listGroups: async () => [{ groupId: 'sales', displayName: '销售部' }],
        listGroupIdsForUser: async (_tenantId: string, userId: string) =>
          userId === 'u1' ? ['sales'] : [],
      } as never,
      agents: {
        listByTenant: () => [
          { id: 'agent-1', name: '销售助手', enabled: true },
          { id: 'agent-2', name: '停用助手', enabled: false },
        ],
      } as never,
    });

    const result = await service.read({
      tenantId: 'tenant-a',
      installationId: 'install-demo',
      kind: 'user',
      limit: 20,
    });

    expect(result.summary).toEqual({
      effectiveUserCount: 1,
      effectiveAgentCount: 1,
      pendingPersonalAuthorizationCount: 0,
      ruleCount: 2,
    });
    expect(result.users).toEqual([
      expect.objectContaining({
        userId: 'u1',
        displayName: 'Alice',
        departmentNames: ['销售部'],
        accessSources: ['directory_group'],
      }),
    ]);
    expect(result.agents).toEqual([]);
    expect(listEffectiveResourceIds).not.toHaveBeenCalledWith(
      'tenant-a',
      'u3',
      'system_installation',
    );
  });
});
