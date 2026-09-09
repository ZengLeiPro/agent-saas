import { describe, expect, it, vi } from 'vitest';

import { InstallationAccessOverviewService } from './accessOverview.js';

const digest = 'a'.repeat(64);

describe('InstallationAccessOverviewService', () => {
  it('用集合授权查询返回真实用户观测与受限 Agent 状态', async () => {
    const listEffectiveSubjectsForInstallation = vi.fn().mockResolvedValue([
      {
        subjectType: 'user',
        subjectId: 'u1',
        bindings: [
          {
            assignmentId: 'allow-group',
            assigneeType: 'directory_group',
            assigneeId: 'sales',
            effect: 'allow',
            origin: 'direct',
          },
        ],
      },
      ...['agent-1', 'agent-2'].map((subjectId) => ({
        subjectType: 'agent',
        subjectId,
        bindings: [
          {
            assignmentId: `allow-${subjectId}`,
            assigneeType: 'agent',
            assigneeId: subjectId,
            effect: 'allow',
            origin: 'direct',
          },
        ],
      })),
    ]);
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
      assignments: { listEffectiveSubjectsForInstallation } as never,
      assignmentSets: { getAssignmentSet: async () => ({ assignments: [{}, {}] }) } as never,
      observations: {
        listForInstallation: async () => [
          {
            tenantId: 'tenant-a',
            installationId: 'install-demo',
            userId: 'u1',
            registeredDigest: digest,
            status: 'ready',
            enabledCapabilityCount: 1,
            checkedAt: '2026-09-08T01:00:00.000Z',
          },
        ],
      },
      groups: {
        listGroups: async () => [{ groupId: 'sales', displayName: '销售部' }],
      } as never,
      agents: {
        listByTenant: () => [
          { id: 'agent-1', name: '销售助手', enabled: true },
          {
            id: 'agent-2',
            name: '受限助手',
            enabled: true,
            runtime: { schemaVersion: 1, apps: { denySystems: ['erp'] } },
          },
          { id: 'agent-3', name: '停用助手', enabled: false },
        ],
      } as never,
    });
    const baseInput = {
      tenantId: 'tenant-a',
      installationId: 'install-demo',
      systemId: 'erp',
      registeredDigest: digest,
      capabilityIds: ['orders.read'] as string[],
      limit: 20,
    } as const;

    const users = await service.read({ ...baseInput, kind: 'user' });
    const agents = await service.read({ ...baseInput, kind: 'agent' });

    expect(users.summary).toEqual({
      effectiveUserCount: 1,
      verifiedUsableUserCount: 1,
      effectiveAgentCount: 2,
      restrictedAgentCount: 1,
      pendingPersonalAuthorizationCount: 0,
      ruleCount: 2,
    });
    expect(users.users).toEqual([
      expect.objectContaining({
        userId: 'u1',
        authorized: true,
        displayName: 'Alice',
        departmentNames: ['销售部'],
        accessSources: ['directory_group'],
        personalAuthorizationStatus: 'not_required',
        agentCapabilityStatus: 'ready',
      }),
      expect.objectContaining({
        userId: 'u2',
        authorized: false,
        displayName: 'bob',
        accessSources: [],
        personalAuthorizationStatus: 'not_applicable',
      }),
    ]);
    expect(agents.agents).toEqual([
      expect.objectContaining({
        agentId: 'agent-1',
        capabilityStatus: 'waiting_user_authorization',
      }),
      expect.objectContaining({ agentId: 'agent-2', capabilityStatus: 'restricted' }),
    ]);
    expect(listEffectiveSubjectsForInstallation).toHaveBeenCalledTimes(2);
    expect(listEffectiveSubjectsForInstallation).toHaveBeenLastCalledWith({
      tenantId: 'tenant-a',
      installationId: 'install-demo',
      userIds: ['u1', 'u2'],
      agentIds: ['agent-1', 'agent-2'],
    });
  });

  it('对大组织仍按游标分页且每次请求只执行一次集合授权查询', async () => {
    const userIds = Array.from(
      { length: 240 },
      (_, index) => `u-${String(index).padStart(3, '0')}`,
    );
    const listEffectiveSubjectsForInstallation = vi.fn(async () =>
      userIds.map((userId) => ({
        subjectType: 'user' as const,
        subjectId: userId,
        bindings: [
          {
            assignmentId: 'everyone',
            assigneeType: 'everyone',
            effect: 'allow',
            origin: 'direct',
          },
        ],
      })),
    );
    const service = new InstallationAccessOverviewService({
      users: {
        listAll: () => userIds.map((id) => ({ id, username: id, tenantId: 'tenant-a' })),
      } as never,
      memberships: {
        listMemberships: async () => userIds.map((userId) => ({ userId, status: 'active' })),
      } as never,
      assignments: { listEffectiveSubjectsForInstallation } as never,
      assignmentSets: { getAssignmentSet: async () => ({ assignments: [{}] }) } as never,
      observations: { listForInstallation: async () => [] },
    });
    const baseInput = {
      tenantId: 'tenant-a',
      installationId: 'install-demo',
      systemId: 'erp',
      registeredDigest: digest,
      capabilityIds: ['orders.read'],
      kind: 'user' as const,
      limit: 100,
    };

    const first = await service.read(baseInput);
    expect(first.users).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.summary.effectiveUserCount).toBe(240);
    expect(listEffectiveSubjectsForInstallation).toHaveBeenCalledTimes(1);

    const second = await service.read({ ...baseInput, cursor: first.nextCursor! });
    expect(second.users).toHaveLength(100);
    expect(second.users[0]).toMatchObject({ userId: 'u-100' });
    expect(second.nextCursor).toEqual(expect.any(String));
    expect(listEffectiveSubjectsForInstallation).toHaveBeenCalledTimes(2);
  });
});
